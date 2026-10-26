import { convert } from "html-to-text";
import PostalMime from "postal-mime";
import { makeClassifier } from "./classifier";
import { makeDatabase } from "./database";
import { makeOutbox } from "./outbox";
import { makeStorage } from "./storage";
import * as Constants from "./worker.constants";
import * as Types from "./worker.types";
import * as Utils from "./worker.utils";

export function makeMail(env: Env, deps: Types.Deps) {
  const screening = env.AGENTS_MAIL_JEV === "true";
  const database = makeDatabase(env.DB, screening);
  const storage = makeStorage(env.BUCKET);
  const outbox = makeOutbox(env.EMAIL);
  const classifier = makeClassifier(env, deps);

  async function open(id: string): Promise<Types.Email | null> {
    const [email, attachments] = await Promise.all([
      database.find(id),
      database.attachments(id),
    ]);

    return email && { ...email, attachments };
  }

  async function dispatch(outgoing: Types.Outgoing): Promise<Types.SendResult> {
    if (Utils.domain(outgoing.from) !== Utils.domain(env.AGENTS_MAIL_FROM)) {
      throw Utils.problem(400, "`from` must use the same domain as AGENTS_MAIL_FROM.");
    }

    const checked = Types.outgoing.safeParse(outgoing);

    if (!checked.success) {
      throw Utils.problem(400, `This email can't be sent: ${Types.prettifyError(checked.error)}`);
    }

    const text = outgoing.text?.trim() ? outgoing.text : outgoing.html && convert(outgoing.html, Constants.TEXT_OPTIONS);

    const size = [text ?? "", outgoing.html ?? ""].reduce((total, part) => total + Constants.ENCODER.encode(part).length, 0)
      + outgoing.files.reduce((total, file) => total + file.size, 0);

    if (size > Constants.MAX_SEND_BYTES) {
      throw Utils.problem(400, "The email is over Cloudflare's 5 MiB limit, attachments included.");
    }

    const sentAt = new Date().toISOString();

    const messageId = await outbox.send({
      from: Utils.mailbox(outgoing.from),
      to: Utils.mailboxes(outgoing.to),
      cc: outgoing.cc && Utils.mailboxes(outgoing.cc),
      bcc: outgoing.bcc && Utils.mailboxes(outgoing.bcc),
      replyTo: outgoing.replyTo && Utils.mailbox(outgoing.replyTo),
      subject: outgoing.subject,
      text,
      html: outgoing.html,
      headers: outgoing.headers,
      attachments: outgoing.files.map((file) => ({
        disposition: "attachment",
        filename: file.filename ?? "attachment",
        type: file.mimeType ?? "application/octet-stream",
        content: file.content,
      })),
    });

    const id = crypto.randomUUID();
    const thread = outgoing.thread ?? messageId;
    const to = Utils.recipients(outgoing.to);
    const cc = outgoing.cc ? Utils.recipients(outgoing.cc) : null;
    const files = outgoing.files.map((file) => ({ ...file, emailId: id }));

    try {
      await Promise.all(files.map(async (file) => storage.put(file)));
      await database.insert({
        id,
        messageId,
        thread,
        refs: outgoing.refs ?? null,
        direction: "out",
        sender: Utils.address(outgoing.from).email,
        envelope: null,
        delivered: null,
        recipient: to,
        cc,
        bcc: outgoing.bcc ? Utils.recipients(outgoing.bcc) : null,
        replyTo: outgoing.replyTo ? Utils.address(outgoing.replyTo).email : null,
        sentAt,
        subject: outgoing.subject,
        text: text ?? null,
        html: outgoing.html ?? null,
        code: null,
        link: null,
        readAt: new Date().toISOString(),
      }, files);
    } catch (error) {
      Utils.log("Sent email could not be stored", error);
      await storage.delete(files.map((file) => Utils.key(id, file.id))).catch(() => null);

      return { id, messageId, thread, to, cc, stored: false };
    }

    return { id, messageId, thread, to, cc, stored: true };
  }

  return {
    async list(params: Types.ListParams): Promise<Types.ListResult> {
      const [total, emails] = await Promise.all([
        database.count(params),
        database.search(params),
      ]);

      return { emails, total };
    },

    async get(params: Types.GetParams): Promise<Types.Email | null> {
      const email = await open(params.id);
      const safe = email?.direction === "out" || (email?.injection ?? (screening ? Infinity : 0)) < Constants.SUSPICIOUS;

      return email && (safe || params.include === "suspicious") ? { ...email, html: params.html ? email.html : null } : null;
    },

    async wait(params: Types.WaitParams): Promise<Types.Email | null> {
      const max = Math.min(Number(env.AGENTS_MAIL_WAIT_MAX) || 120, Constants.MAX_WAIT);
      const interval = Math.max(Number(env.AGENTS_MAIL_WAIT_INTERVAL) || 3, Constants.MIN_INTERVAL) * 1_000;
      const deadline = Date.now() + Math.min(params.timeout ?? max, max) * 1_000;
      const sent = params.thread ? await database.correspondents(params.thread) : null;

      const filters = {
        ...Types.listParams.parse({
          direction: "in",
          from: params.from,
          subject: params.subject,
          thread: params.thread,
          include: params.include,
          after: params.after ?? sent?.sentAt ?? new Date().toISOString(),
          limit: 1,
        }),
        delivered: params.to,
        senders: sent?.addresses ?? undefined,
      };

      const poll = async (): Promise<Types.Email | null> => {
        const [found] = await database.search(filters);
        const email = found && await open(found.id);

        if (email) {
          return { ...email, html: null };
        }

        if (Date.now() + interval > deadline) {
          return null;
        }

        await scheduler.wait(interval);

        return poll();
      };

      return poll();
    },

    send(params: Types.SendParams): Promise<Types.SendResult> {
      return dispatch({
        ...params,
        from: params.from ?? env.AGENTS_MAIL_FROM,
        files: params.attachments.map((file) => {
          const content = Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0));

          return { id: crypto.randomUUID(), filename: file.filename, mimeType: file.type, size: content.byteLength, content };
        }),
        headers: {},
      });
    },

    async reply(params: Types.ReplyParams): Promise<Types.SendResult | null> {
      const original = await database.find(params.id);

      if (!original) {
        return null;
      }

      const own = Utils.domain(env.AGENTS_MAIL_FROM);
      const inbound = original.direction === "in";
      const to = params.to ? [params.to].flat() : (inbound ? original.replyTo ?? original.from : original.to).split(", ");

      const everyone = [original.to, original.cc ?? ""]
        .join(", ")
        .split(", ")
        .filter((item) => item && Utils.domain(item) !== own && !to.includes(item));

      const refs = Utils.clip([original.refs, original.messageId].filter(Boolean).join(" "), Constants.MAX_HEADER);

      return dispatch({
        from: inbound ? original.delivered ?? env.AGENTS_MAIL_FROM : original.from,
        to,
        cc: params.all && everyone.length > 0 ? everyone : undefined,
        subject: /^re:/i.test(original.subject ?? "") ? original.subject ?? "" : `Re: ${original.subject ?? ""}`,
        text: params.text,
        html: params.html,
        files: params.attachments.map((file) => {
          const content = Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0));

          return { id: crypto.randomUUID(), filename: file.filename, mimeType: file.type, size: content.byteLength, content };
        }),
        headers: original.messageId ? { "In-Reply-To": original.messageId, "References": refs ?? original.messageId } : {},
        thread: original.thread ?? undefined,
        refs: refs ?? undefined,
      });
    },

    async forward(params: Types.ForwardParams): Promise<Types.SendResult | null> {
      const original = await open(params.id);

      if (!original) {
        return null;
      }

      const files = await Promise.all(original.attachments.map(async (attachment) => {
        const object = await storage.get({ id: original.id, attachment: attachment.id });

        return { ...attachment, id: crypto.randomUUID(), content: await object?.arrayBuffer() ?? new ArrayBuffer(0) };
      }));

      const header = [
        "---------- Forwarded message ---------",
        `From: ${original.from}`,
        `Date: ${original.sentAt ?? original.createdAt}`,
        `Subject: ${original.subject ?? ""}`,
        `To: ${original.to}`,
      ];

      const [note, ...lines] = [params.text ?? "", ...header].map((line) => line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;"));

      return dispatch({
        from: env.AGENTS_MAIL_FROM,
        to: params.to,
        cc: params.cc,
        subject: /^fwd?:/i.test(original.subject ?? "") ? original.subject ?? "" : `Fwd: ${original.subject ?? ""}`,
        text: [params.text ?? "", header.join("\n"), "", original.text ?? ""].join("\n"),
        html: original.html
          ? `<p>${note}</p><p>${lines.join("<br>")}</p>${original.html}`
          : undefined,
        files,
        headers: {},
      });
    },

    mark(params: Types.MarkParams): Promise<boolean> {
      return database.mark(params);
    },

    async destroy(params: Types.DestroyParams): Promise<boolean> {
      await storage.delete(await database.keys([params.id]));

      return await database.delete([params.id]) > 0;
    },

    async download(params: Types.DownloadParams): Promise<R2ObjectBody | null> {
      return await database.exists(params) ? storage.get(params) : null;
    },

    async purge(): Promise<number> {
      const days = Number(env.AGENTS_MAIL_RETENTION_DAYS) || 0;
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

      const round = async (count: number, total: number): Promise<number> => {
        const ids = count < Constants.PURGE_ROUNDS ? await database.expired(cutoff, Constants.PURGE_BATCH) : [];

        if (ids.length === 0) {
          return total;
        }

        await storage.delete(await database.keys(ids));

        return round(count + 1, total + await database.delete(ids));
      };

      return days > 0 ? round(0, 0) : 0;
    },

    async receive(message: ForwardableEmailMessage): Promise<Types.CategorizeParams | null> {
      const local = message.to.toLowerCase().split("@")[0] ?? "";

      const rules = env.AGENTS_MAIL_ACCEPT
        .split(",")
        .map((rule) => rule.trim().toLowerCase())
        .filter(Boolean);

      if (rules.length > 0 && !rules.some((rule) => new RegExp(`^${rule.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(local))) {
        message.setReject("Unknown address.");

        return null;
      }

      if (message.rawSize > Constants.MAX_INBOUND) {
        message.setReject(`Email too large; the limit is ${Constants.MAX_INBOUND / 1024 / 1024} MiB.`);

        return null;
      }

      const limit = Number(env.AGENTS_MAIL_INBOUND_LIMIT) || 0;

      if (limit > 0 && await database.received(new Date(Date.now() - 86_400_000).toISOString()) >= limit) {
        message.setReject("Mailbox is over its daily limit; try again later.");

        return null;
      }

      const id = crypto.randomUUID();
      const email = await PostalMime.parse(message.raw);

      if (email.attachments.length > Constants.MAX_ATTACHMENTS) {
        message.setReject(`Too many attachments; the limit is ${Constants.MAX_ATTACHMENTS}.`);

        return null;
      }

      const html = Utils.clip(email.html, Constants.MAX_HTML);
      const text = email.text?.trim() ? email.text : html && convert(html, Constants.TEXT_OPTIONS);

      const attachments = email.attachments.map((file) => ({
        id: crypto.randomUUID(),
        emailId: id,
        filename: Utils.clip(file.filename, Constants.MAX_FILENAME),
        mimeType: Utils.clip(file.mimeType, Constants.MAX_FILENAME),
        size: new Blob([file.content]).size,
        content: file.content,
      }));

      const uploads = await Promise.allSettled(attachments.map(async (attachment) => storage.put(attachment)));

      const sender = Utils.clip(Utils.unpack(email.from && [email.from]).at(0) ?? message.from.toLowerCase(), Constants.MAX_HEADER) ?? "";
      const envelope = Utils.clip(message.from.toLowerCase(), Constants.MAX_HEADER);
      const subject = Utils.clip(email.subject, Constants.MAX_HEADER);
      const body = Utils.clip(text, Constants.MAX_TEXT);
      const messageId = Utils.clip(email.messageId, Constants.MAX_HEADER);
      const refs = Utils.clip(email.references, Constants.MAX_HEADER);
      const content = `${subject ?? ""}\n${body ?? ""}`;
      const code = Constants.CODE.exec(content);
      const link = [...content.matchAll(Constants.LINK)].map(([url]) => url).find((url) => Constants.LINK_HINT.test(url));

      try {
        const failed = uploads.find((upload): upload is PromiseRejectedResult => upload.status === "rejected");

        if (failed) {
          throw failed.reason;
        }

        await database.insert({
          id,
          messageId,
          thread: Utils.clip(refs?.split(/\s+/)[0] ?? email.inReplyTo ?? messageId ?? id, Constants.MAX_HEADER) ?? id,
          refs,
          direction: "in",
          sender,
          envelope,
          delivered: Utils.clip(message.to.toLowerCase(), Constants.MAX_HEADER),
          recipient: Utils.clip([...new Set([message.to.toLowerCase(), ...Utils.unpack(email.to)])].join(", "), Constants.MAX_HEADER) ?? "",
          cc: Utils.clip(Utils.unpack(email.cc).join(", "), Constants.MAX_HEADER),
          bcc: null,
          replyTo: Utils.clip(Utils.unpack(email.replyTo).join(", "), Constants.MAX_HEADER),
          sentAt: Utils.clip(email.date, Constants.MAX_HEADER),
          subject,
          text: body,
          html,
          code: code?.[1] ?? code?.[2] ?? null,
          link: Utils.clip(link, Constants.MAX_HEADER),
          readAt: null,
        }, attachments);
      } catch (error) {
        await storage.delete(attachments.map((attachment) => Utils.key(id, attachment.id)));

        throw error;
      }

      return { id, from: sender, envelope, subject, text: body, files: attachments.map((attachment) => attachment.filename ?? "").join(", ") };
    },

    async categorize(params: Types.CategorizeParams): Promise<void> {
      try {
        const result = await classifier.classify(params);

        if (result) {
          await database.label(params.id, result);
        }
      } catch (error) {
        Utils.log("JEV categorization failed", error);
      }
    },
  };
}

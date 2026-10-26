import { convert } from "html-to-text";
import PostalMime from "postal-mime";
import { makeClassifier } from "./classifier";
import { makeDatabase } from "./database";
import { makeOutbox } from "./outbox";
import { makeStorage } from "./storage";
import * as Constants from "./worker.constants";
import * as Types from "./worker.types";
import * as Utils from "./worker.utils";

export function makeMail(env: Env, deps: Types.WorkerDeps) {
  const screening = env.AGENTS_MAIL_JEV === "true";
  const database = makeDatabase(env.DB, screening);
  const storage = makeStorage(env.BUCKET);
  const outbox = makeOutbox(env.EMAIL);
  const classifier = makeClassifier(env, deps);

  async function open(id: string): Promise<Types.WorkerEmail | null> {
    const [email, attachments] = await Promise.all([
      database.find(id),
      database.attachments(id),
    ]);

    return email && { ...email, attachments };
  }

  async function dispatch(outgoing: Types.WorkerOutgoing): Promise<Types.WorkerSendResult> {
    if (Utils.workerDomain(outgoing.from) !== Utils.workerDomain(env.AGENTS_MAIL_FROM)) {
      throw Utils.workerProblem(400, "`from` must use the same domain as AGENTS_MAIL_FROM.");
    }

    const checked = Types.workerOutgoing.safeParse(outgoing);

    if (!checked.success) {
      throw Utils.workerProblem(400, `This email can't be sent: ${Types.workerPrettifyError(checked.error)}`);
    }

    const text = outgoing.text?.trim() ? outgoing.text : outgoing.html && convert(outgoing.html, Constants.WORKER_TEXT_OPTIONS);

    const size = [text ?? "", outgoing.html ?? ""].reduce((total, part) => total + Constants.WORKER_ENCODER.encode(part).length, 0)
      + outgoing.files.reduce((total, file) => total + file.size, 0);

    if (size > Constants.WORKER_MAX_SEND_BYTES) {
      throw Utils.workerProblem(400, "The email is over Cloudflare's 5 MiB limit, attachments included.");
    }

    const sentAt = new Date().toISOString();

    const messageId = await outbox.send({
      from: Utils.workerMailbox(outgoing.from),
      to: Utils.workerMailboxes(outgoing.to),
      cc: outgoing.cc && Utils.workerMailboxes(outgoing.cc),
      bcc: outgoing.bcc && Utils.workerMailboxes(outgoing.bcc),
      replyTo: outgoing.replyTo && Utils.workerMailbox(outgoing.replyTo),
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
    const to = Utils.workerRecipients(outgoing.to);
    const cc = outgoing.cc ? Utils.workerRecipients(outgoing.cc) : null;
    const files = outgoing.files.map((file) => ({ ...file, emailId: id }));

    try {
      await Promise.all(files.map(async (file) => storage.put(file)));
      await database.insert({
        id,
        messageId,
        thread,
        refs: outgoing.refs ?? null,
        direction: "out",
        sender: Utils.workerAddress(outgoing.from).email,
        envelope: null,
        delivered: null,
        recipient: to,
        cc,
        bcc: outgoing.bcc ? Utils.workerRecipients(outgoing.bcc) : null,
        replyTo: outgoing.replyTo ? Utils.workerAddress(outgoing.replyTo).email : null,
        sentAt,
        subject: outgoing.subject,
        text: text ?? null,
        html: outgoing.html ?? null,
        code: null,
        link: null,
        readAt: new Date().toISOString(),
      }, files);
    } catch (error) {
      Utils.workerLog("Sent email could not be stored", error);
      await storage.delete(files.map((file) => Utils.workerKey(id, file.id))).catch(() => null);

      return { id, messageId, thread, to, cc, stored: false };
    }

    return { id, messageId, thread, to, cc, stored: true };
  }

  return {
    async list(params: Types.WorkerListParams): Promise<Types.WorkerListResult> {
      const [total, emails] = await Promise.all([
        database.count(params),
        database.search(params),
      ]);

      return { emails, total };
    },

    async get(params: Types.WorkerGetParams): Promise<Types.WorkerEmail | null> {
      const email = await open(params.id);
      const safe = email?.direction === "out" || (email?.injection ?? (screening ? Infinity : 0)) < Constants.WORKER_SUSPICIOUS;

      return email && (safe || params.include === "suspicious") ? { ...email, html: params.html ? email.html : null } : null;
    },

    async wait(params: Types.WorkerWaitParams): Promise<Types.WorkerEmail | null> {
      const max = Math.min(Number(env.AGENTS_MAIL_WAIT_MAX) || 120, Constants.WORKER_MAX_WAIT);
      const interval = Math.max(Number(env.AGENTS_MAIL_WAIT_INTERVAL) || 3, Constants.WORKER_MIN_INTERVAL) * 1_000;
      const deadline = Date.now() + Math.min(params.timeout ?? max, max) * 1_000;
      const sent = params.thread ? await database.correspondents(params.thread) : null;

      const filters = {
        ...Types.workerListParams.parse({
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

      const poll = async (): Promise<Types.WorkerEmail | null> => {
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

    send(params: Types.WorkerSendParams): Promise<Types.WorkerSendResult> {
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

    async reply(params: Types.WorkerReplyParams): Promise<Types.WorkerSendResult | null> {
      const original = await database.find(params.id);

      if (!original) {
        return null;
      }

      const own = Utils.workerDomain(env.AGENTS_MAIL_FROM);
      const inbound = original.direction === "in";
      const to = params.to ? [params.to].flat() : (inbound ? original.replyTo ?? original.from : original.to).split(", ");

      const everyone = [original.to, original.cc ?? ""]
        .join(", ")
        .split(", ")
        .filter((item) => item && Utils.workerDomain(item) !== own && !to.includes(item));

      const refs = Utils.workerClip([original.refs, original.messageId].filter(Boolean).join(" "), Constants.WORKER_MAX_HEADER);

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

    async forward(params: Types.WorkerForwardParams): Promise<Types.WorkerSendResult | null> {
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

    mark(params: Types.WorkerMarkParams): Promise<boolean> {
      return database.mark(params);
    },

    async destroy(params: Types.WorkerDestroyParams): Promise<boolean> {
      await storage.delete(await database.keys([params.id]));

      return await database.delete([params.id]) > 0;
    },

    async download(params: Types.WorkerDownloadParams): Promise<R2ObjectBody | null> {
      return await database.exists(params) ? storage.get(params) : null;
    },

    async purge(): Promise<number> {
      const days = Number(env.AGENTS_MAIL_RETENTION_DAYS) || 0;
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

      const round = async (count: number, total: number): Promise<number> => {
        const ids = count < Constants.WORKER_PURGE_ROUNDS ? await database.expired(cutoff, Constants.WORKER_PURGE_BATCH) : [];

        if (ids.length === 0) {
          return total;
        }

        await storage.delete(await database.keys(ids));

        return round(count + 1, total + await database.delete(ids));
      };

      return days > 0 ? round(0, 0) : 0;
    },

    async receive(message: ForwardableEmailMessage): Promise<Types.WorkerCategorizeParams | null> {
      const local = message.to.toLowerCase().split("@")[0] ?? "";

      const rules = env.AGENTS_MAIL_ACCEPT
        .split(",")
        .map((rule) => rule.trim().toLowerCase())
        .filter(Boolean);

      if (rules.length > 0 && !rules.some((rule) => new RegExp(`^${rule.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(local))) {
        message.setReject("Unknown address.");

        return null;
      }

      if (message.rawSize > Constants.WORKER_MAX_INBOUND) {
        message.setReject(`Email too large; the limit is ${Constants.WORKER_MAX_INBOUND / 1024 / 1024} MiB.`);

        return null;
      }

      const limit = Number(env.AGENTS_MAIL_INBOUND_LIMIT) || 0;

      if (limit > 0 && await database.received(new Date(Date.now() - 86_400_000).toISOString()) >= limit) {
        message.setReject("Mailbox is over its daily limit; try again later.");

        return null;
      }

      const id = crypto.randomUUID();
      const email = await PostalMime.parse(message.raw);

      if (email.attachments.length > Constants.WORKER_MAX_ATTACHMENTS) {
        message.setReject(`Too many attachments; the limit is ${Constants.WORKER_MAX_ATTACHMENTS}.`);

        return null;
      }

      const html = Utils.workerClip(email.html, Constants.WORKER_MAX_HTML);
      const text = email.text?.trim() ? email.text : html && convert(html, Constants.WORKER_TEXT_OPTIONS);

      const attachments = email.attachments.map((file) => ({
        id: crypto.randomUUID(),
        emailId: id,
        filename: Utils.workerClip(file.filename, Constants.WORKER_MAX_FILENAME),
        mimeType: Utils.workerClip(file.mimeType, Constants.WORKER_MAX_FILENAME),
        size: new Blob([file.content]).size,
        content: file.content,
      }));

      const uploads = await Promise.allSettled(attachments.map(async (attachment) => storage.put(attachment)));

      const sender = Utils.workerClip(Utils.workerUnpack(email.from && [email.from]).at(0) ?? message.from.toLowerCase(), Constants.WORKER_MAX_HEADER) ?? "";
      const envelope = Utils.workerClip(message.from.toLowerCase(), Constants.WORKER_MAX_HEADER);
      const subject = Utils.workerClip(email.subject, Constants.WORKER_MAX_HEADER);
      const body = Utils.workerClip(text, Constants.WORKER_MAX_TEXT);
      const messageId = Utils.workerClip(email.messageId, Constants.WORKER_MAX_HEADER);
      const refs = Utils.workerClip(email.references, Constants.WORKER_MAX_HEADER);
      const content = `${subject ?? ""}\n${body ?? ""}`;
      const code = Constants.WORKER_CODE.exec(content);
      const link = [...content.matchAll(Constants.WORKER_LINK)].map(([url]) => url).find((url) => Constants.WORKER_LINK_HINT.test(url));

      try {
        const failed = uploads.find((upload): upload is PromiseRejectedResult => upload.status === "rejected");

        if (failed) {
          throw failed.reason;
        }

        await database.insert({
          id,
          messageId,
          thread: Utils.workerClip(refs?.split(/\s+/)[0] ?? email.inReplyTo ?? messageId ?? id, Constants.WORKER_MAX_HEADER) ?? id,
          refs,
          direction: "in",
          sender,
          envelope,
          delivered: Utils.workerClip(message.to.toLowerCase(), Constants.WORKER_MAX_HEADER),
          recipient: Utils.workerClip([...new Set([message.to.toLowerCase(), ...Utils.workerUnpack(email.to)])].join(", "), Constants.WORKER_MAX_HEADER) ?? "",
          cc: Utils.workerClip(Utils.workerUnpack(email.cc).join(", "), Constants.WORKER_MAX_HEADER),
          bcc: null,
          replyTo: Utils.workerClip(Utils.workerUnpack(email.replyTo).join(", "), Constants.WORKER_MAX_HEADER),
          sentAt: Utils.workerClip(email.date, Constants.WORKER_MAX_HEADER),
          subject,
          text: body,
          html,
          code: code?.[1] ?? code?.[2] ?? null,
          link: Utils.workerClip(link, Constants.WORKER_MAX_HEADER),
          readAt: null,
        }, attachments);
      } catch (error) {
        await storage.delete(attachments.map((attachment) => Utils.workerKey(id, attachment.id)));

        throw error;
      }

      return { id, from: sender, envelope, subject, text: body, files: attachments.map((attachment) => attachment.filename ?? "").join(", ") };
    },

    async categorize(params: Types.WorkerCategorizeParams): Promise<void> {
      try {
        const result = await classifier.classify(params);

        if (result) {
          await database.label(params.id, result);
        }
      } catch (error) {
        Utils.workerLog("JEV categorization failed", error);
      }
    },
  };
}

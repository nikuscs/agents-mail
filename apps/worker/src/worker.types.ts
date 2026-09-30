import { z } from "zod";
import { MAX_ATTACHMENTS, MAX_FILENAME, MAX_HEADER, MAX_MAILBOX, MAX_RECIPIENTS, MAX_SEND_ATTACHMENTS, MAX_WAIT } from "./worker.constants";
import type { Fetch } from "@typesafe-ai/sdk";
import type { Attachment as MimeAttachment } from "postal-mime";

const MAILBOX = /^(?:(?:"[^"\r\n]*"\s*|[^"<>,\r\n]*)<[^\s"<>,@]+@[^\s"<>,@]+\.[^\s"<>,@]+>|[^\s"<>,@]+@[^\s"<>,@]+\.[^\s"<>,@]+)$/;

const LINE = /^[^\r\n]*$/;

const MIME = /^[\w.+-]+\/[\w.+-]+$/;

export const category = z.enum([
  "conversation",
  "transactional",
  "security",
  "notification",
  "newsletter",
  "marketing",
  "spam",
  "phishing",
]);
export type Category = z.infer<typeof category>;

const date = z.union([z.iso.date(), z.iso.datetime({ offset: true, local: true })]);
const mailbox = z.string().trim().max(MAX_MAILBOX, { abort: true }).regex(MAILBOX, "Use one address per value, e.g. `jane@example.org` or `Jane <jane@example.org>`.");
const addresses = z.union([mailbox, z.array(mailbox).min(1).max(MAX_RECIPIENTS)]);
const body = z.string().optional();
const subject = z.string().trim().min(1).max(998).regex(LINE, "Subject must be a single line.");
const flag = z.union([z.boolean(), z.stringbool()]);

const file = z.object({
  filename: z.string().trim().min(1).max(MAX_FILENAME).regex(LINE, "Filename must be a single line."),
  type: z.string().trim().regex(MIME, "Use a MIME type like `application/pdf`."),
  content: z.base64().describe("File content, base64 encoded."),
});

export const listParams = z.object({
  direction: z.enum(["in", "out"]).optional().describe("Only received (in) or sent (out) emails."),
  status: z.enum(["unread", "read"]).optional().describe("Only unread or read emails."),
  from: z.string().trim().optional().describe("Exact sender address."),
  to: z.string().trim().optional().describe("Recipient address; matches any address in the recipient list."),
  subject: z.string().trim().max(200).optional().describe("Text the subject contains, case-insensitive."),
  q: z.string().trim().max(200).optional().describe("Text to search in the subject and body, case-insensitive."),
  thread: z.string().trim().max(1_000).optional().describe("Only emails in this thread."),
  category: category.optional().describe("Only emails JEV put in this category."),
  include: z.enum(["suspicious"]).optional().describe("Also list emails flagged as likely prompt injection, or not scored yet. Hidden by default."),
  after: date.optional().describe("Only emails on or after this ISO date or datetime (UTC when no offset)."),
  before: date.optional().describe("Only emails before this ISO date or datetime (UTC when no offset)."),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListParams = z.infer<typeof listParams>;

export const waitParams = z.object({
  to: z.string().trim().optional().describe("Address the email was delivered to, e.g. a signup alias. Uses the SMTP recipient, which headers can't fake."),
  from: z.string().trim().optional().describe("Exact sender address."),
  subject: z.string().trim().max(200).optional().describe("Text the subject contains, case-insensitive."),
  thread: z.string().trim().max(1_000).optional().describe("Wait for a reply in this thread, e.g. the `thread` a send or reply returned. Only replies from addresses in the mail you sent there count."),
  timeout: z.coerce.number().int().min(1).max(MAX_WAIT).optional().describe("Seconds to wait. Capped by the server's AGENTS_MAIL_WAIT_MAX."),
  after: date.optional().describe("Only emails received on or after this time. Defaults to your latest sent email in `thread`, else to when the wait starts."),
  include: z.enum(["suspicious"]).optional(),
});
export type WaitParams = z.infer<typeof waitParams>;

export const getParams = z.object({
  id: z.uuid(),
  include: z.enum(["suspicious"]).optional().describe("Also return an email flagged as likely prompt injection, or not scored yet."),
  html: flag.default(false).describe("Also return the raw html. JEV does not screen it; prefer `text`."),
});
export type GetParams = z.infer<typeof getParams>;

export const destroyParams = z.object({
  id: z.uuid(),
});
export type DestroyParams = z.infer<typeof destroyParams>;

export const markParams = z.object({
  id: z.uuid(),
  read: z.boolean().default(true).describe("true marks it read, false marks it unread."),
});
export type MarkParams = z.infer<typeof markParams>;

export const downloadParams = z.object({
  id: z.uuid(),
  attachment: z.uuid(),
});
export type DownloadParams = z.infer<typeof downloadParams>;

export const sendParams = z
  .object({
    from: mailbox.optional().describe("Sender, e.g. `Agent <agent@example.com>`. Defaults to AGENTS_MAIL_FROM."),
    to: addresses,
    cc: addresses.optional(),
    bcc: addresses.optional(),
    replyTo: mailbox.optional(),
    subject,
    text: body,
    html: body,
    attachments: z.array(file).max(MAX_SEND_ATTACHMENTS).default([]),
  })
  .refine((params) => [params.text, params.html].some(Boolean), { message: "Provide text, html or both." })
  .refine((params) => [params.to, params.cc ?? [], params.bcc ?? []].flat().length <= MAX_RECIPIENTS, { message: `Use at most ${MAX_RECIPIENTS} recipients across to, cc and bcc.` });
export type SendParams = z.infer<typeof sendParams>;

export const replyParams = z
  .object({
    id: z.uuid().describe("The email to reply to."),
    to: addresses.optional().describe("Send the reply here instead of the email's Reply-To or From, which its sender controls."),
    text: body,
    html: body,
    all: z.boolean().default(false).describe("Reply to every recipient, not just the sender."),
    attachments: z.array(file).max(MAX_SEND_ATTACHMENTS).default([]),
  })
  .refine((params) => [params.text, params.html].some(Boolean), { message: "Provide text, html or both." });
export type ReplyParams = z.infer<typeof replyParams>;

export const forwardParams = z.object({
  id: z.uuid().describe("The email to forward, with its attachments."),
  to: addresses,
  cc: addresses.optional(),
  text: body.describe("Optional note above the forwarded message."),
});
export type ForwardParams = z.infer<typeof forwardParams>;

export const outgoing = z
  .object({
    from: mailbox,
    to: addresses,
    cc: addresses.optional(),
    bcc: addresses.optional(),
    replyTo: mailbox.optional(),
    subject,
    headers: z.record(z.string(), z.string().max(MAX_HEADER).regex(LINE, "Headers must be a single line.")),
    files: z.array(z.object({
      filename: z.string().max(MAX_FILENAME).regex(LINE, "Filenames must be a single line.").nullable(),
      mimeType: z.string().regex(MIME, "Attachment types must look like `application/pdf`.").nullable(),
    })).max(MAX_ATTACHMENTS),
  })
  .refine((params) => [params.to, params.cc ?? [], params.bcc ?? []].flat().length <= MAX_RECIPIENTS, { message: `Use at most ${MAX_RECIPIENTS} recipients across to, cc and bcc.` });

export const sendFailure = z.object({
  code: z.string().startsWith("E_"),
  message: z.string(),
});
export type SendFailure = z.infer<typeof sendFailure>;

export type File = z.infer<typeof file>;

export type Addresses = z.infer<typeof addresses>;

export type Mailbox = EmailAddress | string;

export type Direction = "in" | "out";

export type Scope = "full" | "read";

export interface Deps {
  fetch?: Fetch;
}

export interface AppEnv {
  Bindings: Env;
  Variables: { scope: Scope };
}

export interface SendResult {
  id: string;
  messageId: string;
  thread: string;
  to: string;
  cc: string | null;
  stored: boolean;
}

export interface Summary {
  id: string;
  thread: string | null;
  direction: Direction;
  from: string;
  to: string;
  subject: string | null;
  code: string | null;
  link: string | null;
  category: Category | null;
  injection: number | null;
  readAt: string | null;
  attachments: number;
  createdAt: string;
}

export interface ListResult {
  emails: Summary[];
  total: number;
}

export interface Attachment {
  id: string;
  filename: string | null;
  mimeType: string | null;
  size: number;
}

export interface Detail extends Omit<Summary, "attachments"> {
  messageId: string | null;
  refs: string | null;
  envelope: string | null;
  delivered: string | null;
  confidence: number | null;
  cc: string | null;
  bcc: string | null;
  replyTo: string | null;
  sentAt: string | null;
  text: string | null;
  html: string | null;
}

export interface Email extends Detail {
  attachments: Attachment[];
}

export interface InsertParams {
  id: string;
  messageId: string | null;
  thread: string;
  refs: string | null;
  direction: Direction;
  sender: string;
  envelope: string | null;
  delivered: string | null;
  recipient: string;
  cc: string | null;
  bcc: string | null;
  replyTo: string | null;
  sentAt: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  code: string | null;
  link: string | null;
  readAt: string | null;
}

export interface AttachParams extends Attachment {
  emailId: string;
}

export interface PutParams extends AttachParams {
  content: MimeAttachment["content"];
}

export interface Outgoing {
  from: string;
  to: Addresses;
  cc?: Addresses;
  bcc?: Addresses;
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  files: Omit<PutParams, "emailId">[];
  headers: Record<string, string>;
  thread?: string;
  refs?: string;
}

export interface SearchParams extends ListParams {
  delivered?: string;
  senders?: string;
}

export interface Where {
  sql: string;
  values: (string | number)[];
}

export type Filter = [string, string | number];

export interface CategorizeParams {
  id: string;
  from: string;
  envelope: string | null;
  subject: string | null;
  text: string | null;
  files: string;
}

export const categorizeResult = z.object({
  category,
  confidence: z.number().min(0).max(1),
  injection: z.number().min(0).max(1),
});
export type CategorizeResult = z.infer<typeof categorizeResult>;

import type { WorkerCategory } from "./worker.types";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HtmlToTextOptions } from "html-to-text";

export const WORKER_VERSION = "0.0.2";

export const WORKER_SUSPICIOUS = 0.8;

export const WORKER_JEV_URL = "https://api.typesafe.ai";

export const WORKER_JEV_CHUNK = 8_000;

export const WORKER_MAX_HTML = 500_000;

export const WORKER_MAX_TEXT = 200_000;

export const WORKER_MAX_HEADER = 2_000;

export const WORKER_MAX_MAILBOX = 1_000;

export const WORKER_MAX_FILENAME = 255;

export const WORKER_MAX_INBOUND = 10 * 1024 * 1024;

export const WORKER_MAX_ATTACHMENTS = 50;

export const WORKER_MAX_RECIPIENTS = 50;

export const WORKER_MAX_BATCH = 10;

export const WORKER_MAX_BODY = 8 * 1024 * 1024;

export const WORKER_MAX_SEND_BYTES = 5 * 1024 * 1024;

export const WORKER_MAX_SEND_ATTACHMENTS = 32;

export const WORKER_MAX_WAIT = 240;

export const WORKER_MIN_INTERVAL = 1;

export const WORKER_PURGE_BATCH = 20;

export const WORKER_PURGE_ROUNDS = 50;

export const WORKER_CODE = /(?:code|otp|passcode|pin|verification|one[- ]time)\D{0,40}?\b(\d{4,8})\b|\b(\d{4,8})\b\D{0,20}?\b(?:code|otp|passcode|pin)\b/i;

export const WORKER_LINK = /https?:\/\/[^\s"'<>)\]]+/g;

export const WORKER_LINK_HINT = /verif|confirm|activat|magic|sign-?in|log-?in|reset|token|auth/i;

export const WORKER_MIN_TOKEN = 32;

export const WORKER_ENCODER = new TextEncoder();

export const WORKER_DECODER = new TextDecoder();

export const WORKER_TEXT_OPTIONS = {
  wordwrap: false,
  limits: { maxDepth: 64, maxInputLength: WORKER_MAX_HTML },
  selectors: [
    { selector: "img", format: "skip" },
    { selector: "a", options: { ignoreHref: true } },
  ],
} satisfies HtmlToTextOptions;

export const WORKER_DOWNLOAD_HEADERS = {
  "cache-control": "private, no-store",
  "content-security-policy": "default-src 'none'; sandbox",
  "x-content-type-options": "nosniff",
};

export const WORKER_SEND_STATUS = new Map<string, ContentfulStatusCode>([
  ["E_RATE_LIMIT_EXCEEDED", 429],
  ["E_DAILY_LIMIT_EXCEEDED", 429],
  ["E_DELIVERY_FAILED", 502],
  ["E_INTERNAL_SERVER_ERROR", 502],
]);

export const WORKER_SUMMARY = `id, thread, direction, sender AS "from", recipient AS "to", subject, code, link, category, injection,
  read_at AS readAt, created_at AS createdAt,
  (SELECT COUNT(*) FROM attachments WHERE email_id = emails.id) AS attachments`;

export const WORKER_DETAIL = `id, message_id AS messageId, thread, refs, direction, sender AS "from", envelope, delivered, recipient AS "to", cc, bcc,
  reply_to AS replyTo, sent_at AS sentAt, subject, text, html, code, link, category, confidence, injection,
  read_at AS readAt, created_at AS createdAt`;

export const WORKER_INSERT_EMAIL = `INSERT INTO emails
  (id, message_id, thread, refs, direction, sender, envelope, delivered, recipient, cc, bcc, reply_to, sent_at, subject, text, html,
  code, link, read_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const WORKER_INSERT_ATTACHMENT = "INSERT INTO attachments (id, email_id, filename, mime_type, size) VALUES (?, ?, ?, ?, ?)";

export const WORKER_CATEGORIES = {
  conversation: "A person writing directly, usually expecting a reply.",
  transactional: "Receipts, invoices, orders, bookings or shipping updates.",
  security: "Login codes, password resets, two-factor or account security alerts.",
  notification: "Automated alerts or updates from a product or service.",
  newsletter: "A subscribed publication or digest.",
  marketing: "Promotions, offers or sales outreach.",
  spam: "Unsolicited junk with no real purpose for the recipient.",
  phishing: "Tries to steal credentials, money or data by impersonation.",
} satisfies Record<WorkerCategory, string>;

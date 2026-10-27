import * as Constants from "./worker.constants";
import * as Utils from "./worker.utils";
import type * as Types from "./worker.types";

export function makeDatabase(db: D1Database, screening: boolean) {
  return {
    async count(params: Types.WorkerSearchParams): Promise<number> {
      const { sql, values } = Utils.workerWhere(params, screening);
      const total = await db.prepare(`SELECT COUNT(*) AS total FROM emails ${sql}`).bind(...values).first<number>("total");

      return total ?? 0;
    },

    async search(params: Types.WorkerSearchParams): Promise<Types.WorkerSummary[]> {
      const { sql, values } = Utils.workerWhere(params, screening);

      const { results } = await db.prepare(`SELECT ${Constants.WORKER_SUMMARY} FROM emails ${sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .bind(...values, params.limit, params.offset)
        .all<Types.WorkerSummary>();

      return results;
    },

    find(id: string): Promise<Types.WorkerDetail | null> {
      return db.prepare(`SELECT ${Constants.WORKER_DETAIL} FROM emails WHERE id = ?`).bind(id).first<Types.WorkerDetail>();
    },

    async attachments(id: string): Promise<Types.WorkerAttachment[]> {
      const { results } = await db.prepare("SELECT id, filename, mime_type AS mimeType, size FROM attachments WHERE email_id = ?")
        .bind(id)
        .all<Types.WorkerAttachment>();

      return results;
    },

    async keys(ids: string[]): Promise<string[]> {
      const { results } = await db.prepare(`SELECT id, email_id AS emailId FROM attachments WHERE email_id IN (${ids.map(() => "?").join(", ")})`)
        .bind(...ids)
        .all<Types.WorkerAttachParams>();

      return results.map((attachment) => Utils.workerKey(attachment.emailId, attachment.id));
    },

    async expired(cutoff: string, limit: number): Promise<string[]> {
      const { results } = await db.prepare("SELECT id FROM emails WHERE created_at < ? LIMIT ?").bind(cutoff, limit).all<Types.WorkerGetParams>();

      return results.map((row) => row.id);
    },

    async insert(email: Types.WorkerInsertParams, attachments: Types.WorkerAttachParams[] = []): Promise<void> {
      await db.batch([
        db.prepare(Constants.WORKER_INSERT_EMAIL).bind(
          email.id,
          email.messageId,
          email.thread,
          email.refs,
          email.direction,
          email.sender,
          email.envelope,
          email.delivered,
          email.recipient,
          email.cc,
          email.bcc,
          email.replyTo,
          email.sentAt,
          email.subject,
          email.text,
          email.html,
          email.code,
          email.link,
          email.readAt,
          new Date().toISOString(),
        ),
        ...attachments.map((attachment) => db.prepare(Constants.WORKER_INSERT_ATTACHMENT).bind(
          attachment.id,
          attachment.emailId,
          attachment.filename,
          attachment.mimeType,
          attachment.size,
        )),
      ]);
    },

    async exists(params: Types.WorkerDownloadParams): Promise<boolean> {
      const row = await db.prepare("SELECT 1 FROM attachments WHERE id = ? AND email_id = ?").bind(params.attachment, params.id).first();

      return row !== null;
    },

    async label(id: string, result: Types.WorkerCategorizeResult): Promise<void> {
      await db.prepare("UPDATE emails SET category = ?, confidence = ?, injection = ? WHERE id = ?")
        .bind(result.category, result.confidence, result.injection, id)
        .run();
    },

    correspondents(thread: string): Promise<{ sentAt: string | null; addresses: string | null } | null> {
      return db.prepare(`SELECT max(sent_at) AS sentAt,
        group_concat(sender || ', ' || recipient || coalesce(', ' || cc, '') || coalesce(', ' || bcc, ''), ', ') AS addresses
        FROM emails WHERE thread = ? AND direction = 'out'`)
        .bind(thread)
        .first();
    },

    async received(since: string): Promise<number> {
      const total = await db.prepare("SELECT COUNT(*) AS total FROM emails WHERE direction = 'in' AND created_at >= ?").bind(since).first<number>("total");

      return total ?? 0;
    },

    async mark(params: Types.WorkerMarkParams): Promise<boolean> {
      const { meta } = await db.prepare("UPDATE emails SET read_at = CASE WHEN ? THEN coalesce(read_at, ?) ELSE NULL END WHERE id = ?")
        .bind(params.read ? 1 : 0, new Date().toISOString(), params.id)
        .run();

      return meta.changes > 0;
    },

    async delete(ids: string[]): Promise<number> {
      const { meta } = await db.prepare(`DELETE FROM emails WHERE id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).run();

      return meta.changes;
    },
  };
}

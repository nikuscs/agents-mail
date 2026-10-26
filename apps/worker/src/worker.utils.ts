import { HTTPException } from "hono/http-exception";
import * as Constants from "./worker.constants";
import type * as Types from "./worker.types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Address } from "postal-mime";

export function workerWhere(params: Types.WorkerSearchParams, jev: boolean): Types.WorkerWhere {
  const hide = params.include === "suspicious" ? undefined : Constants.WORKER_SUSPICIOUS;

  const filters = Object.entries({
    "direction = ?": params.direction,
    "iif(read_at IS NULL, 'unread', 'read') = ?": params.status,
    "sender = ?": params.from?.toLowerCase(),
    "instr(', ' || recipient || ', ', ?) > 0": params.to && `, ${params.to.toLowerCase()}, `,
    "delivered = ?": params.delivered?.toLowerCase(),
    "instr(', ' || ? || ', ', ', ' || sender || ', ') > 0": params.senders,
    "created_at >= ?": params.after && new Date(params.after).toISOString(),
    "created_at < ?": params.before && new Date(params.before).toISOString(),
    "instr(lower(coalesce(subject, '')), ?) > 0": params.subject?.toLowerCase(),
    "instr(lower(coalesce(subject, '') || ' ' || coalesce(text, '')), ?) > 0": params.q?.toLowerCase(),
    "thread = ?": params.thread,
    "category = ?": params.category,
    "(direction = 'out' OR injection < ?)": jev ? hide : undefined,
    "coalesce(injection, 0) < ?": jev ? undefined : hide,
  }).filter((filter): filter is Types.WorkerFilter => Boolean(filter[1]));

  return {
    sql: filters.length > 0 ? `WHERE ${filters.map(([sql]) => sql).join(" AND ")}` : "",
    values: filters.map(([, value]) => value),
  };
}

export function workerAddress(value: string): EmailAddress {
  const [, name = "", email = value] = /^(.*)<([^>]+)>$/.exec(value.trim()) ?? [];

  return { name: name.replaceAll("\"", "").trim(), email: email.trim().toLowerCase() };
}

export function workerMailbox(value: string): Types.WorkerMailbox {
  const { name, email } = workerAddress(value);

  return name ? { name, email } : email;
}

export function workerMailboxes(value: Types.WorkerAddresses): Types.WorkerMailbox[] {
  return [value].flat().map(workerMailbox);
}

export function workerRecipients(value: Types.WorkerAddresses): string {
  return [value]
    .flat()
    .map((item) => workerAddress(item).email)
    .join(", ");
}

export function workerClip(value: string | null | undefined, bytes: number): string | null {
  if (!value) {
    return null;
  }

  const encoded = Constants.WORKER_ENCODER.encode(value);

  if (encoded.length <= bytes) {
    return value;
  }

  const end = encoded.subarray(0, bytes + 1).findLastIndex((byte) => (byte & 0xC0) !== 0x80);

  return Constants.WORKER_DECODER.decode(encoded.subarray(0, end));
}

export function workerUnpack(list: Address[] = []): string[] {
  return list
    .flatMap((item) => item.group ?? [item])
    .map((item) => item.address.toLowerCase());
}

export function workerReply<T>(value: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function workerFail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export async function workerGuard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HTTPException) {
      return workerFail(error.message);
    }

    workerLog("MCP tool failed", error);

    return workerFail("Internal server error.");
  }
}

export function workerProblem(status: ContentfulStatusCode, error: string, code?: string): HTTPException {
  return new HTTPException(status, {
    message: code ? `${code}: ${error}` : error,
    res: Response.json(code ? { error, code } : { error }, { status }),
  });
}

export function workerLog<T>(context: string, error: T): void {
  console.error(context, error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "Unknown error");
}

export function workerDomain(value: string): string {
  return workerAddress(value).email.split("@").at(-1) ?? "";
}

export function workerKey(emailId: string, id: string): string {
  return `${emailId}/${id}`;
}

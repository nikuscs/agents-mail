import { HTTPException } from "hono/http-exception";
import * as Constants from "./worker.constants";
import type * as Types from "./worker.types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Address } from "postal-mime";

export function where(params: Types.SearchParams, jev: boolean): Types.Where {
  const hide = params.include === "suspicious" ? undefined : Constants.SUSPICIOUS;

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
  }).filter((filter): filter is Types.Filter => Boolean(filter[1]));

  return {
    sql: filters.length > 0 ? `WHERE ${filters.map(([sql]) => sql).join(" AND ")}` : "",
    values: filters.map(([, value]) => value),
  };
}

export function address(value: string): EmailAddress {
  const [, name = "", email = value] = /^(.*)<([^>]+)>$/.exec(value.trim()) ?? [];

  return { name: name.replaceAll("\"", "").trim(), email: email.trim().toLowerCase() };
}

export function mailbox(value: string): Types.Mailbox {
  const { name, email } = address(value);

  return name ? { name, email } : email;
}

export function mailboxes(value: Types.Addresses): Types.Mailbox[] {
  return [value].flat().map(mailbox);
}

export function recipients(value: Types.Addresses): string {
  return [value]
    .flat()
    .map((item) => address(item).email)
    .join(", ");
}

export function clip(value: string | null | undefined, bytes: number): string | null {
  if (!value) {
    return null;
  }

  const encoded = Constants.ENCODER.encode(value);

  if (encoded.length <= bytes) {
    return value;
  }

  const end = encoded.subarray(0, bytes + 1).findLastIndex((byte) => (byte & 0xC0) !== 0x80);

  return Constants.DECODER.decode(encoded.subarray(0, end));
}

export function unpack(list: Address[] = []): string[] {
  return list
    .flatMap((item) => item.group ?? [item])
    .map((item) => item.address.toLowerCase());
}

export function reply<T>(value: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HTTPException) {
      return fail(error.message);
    }

    log("MCP tool failed", error);

    return fail("Internal server error.");
  }
}

export function problem(status: ContentfulStatusCode, error: string, code?: string): HTTPException {
  return new HTTPException(status, {
    message: code ? `${code}: ${error}` : error,
    res: Response.json(code ? { error, code } : { error }, { status }),
  });
}

export function log<T>(context: string, error: T): void {
  console.error(context, error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "Unknown error");
}

export function domain(value: string): string {
  return address(value).email.split("@").at(-1) ?? "";
}

export function key(emailId: string, id: string): string {
  return `${emailId}/${id}`;
}

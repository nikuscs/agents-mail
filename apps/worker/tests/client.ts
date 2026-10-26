import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { makeWorker } from "../src/worker";
import type * as Types from "../src/worker.types";

export const worker = makeWorker();

const AUTH = { authorization: "Bearer test-token-0123456789abcdef0123456789" };

export const JEV = { ...env, AGENTS_MAIL_JEV: "true", AGENTS_MAIL_JEV_KEY: "test-key" };

export const READ = { ...env, AGENTS_MAIL_READ_TOKEN: "read-only-token-0123456789abcdef0123456789" };

export const RAW = [
  "From: \"Jane Doe\" <jane@example.org>",
  "To: inbox@example.com",
  "Subject: Invoice 100% paid",
  "Message-ID: <abc@example.org>",
  "MIME-Version: 1.0",
  "Content-Type: multipart/mixed; boundary=\"b\"",
  "",
  "--b",
  "Content-Type: text/plain",
  "",
  "Hello from Jane",
  "--b",
  "Content-Type: text/plain; name=\"note.txt\"",
  "Content-Disposition: attachment; filename=\"note.txt\"",
  "",
  "attached text",
  "--b--",
  "",
].join("\r\n");

export function request(path: string, init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}, bindings: Env = env) {
  return worker.fetch(new Request(`https://mail.test${path}`, { ...init, headers: { ...AUTH, ...init.headers } }), bindings, createExecutionContext());
}

export function post(path: string, body: object, bindings: Env = env) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, bindings);
}

export async function receive(raw = RAW, bindings: Env = env, target = worker, to = "inbox@example.com") {
  const rejected: string[] = [];
  const ctx = createExecutionContext();

  const message: ForwardableEmailMessage = {
    from: "bounce@example.org",
    to,
    raw: new Blob([raw]).stream(),
    headers: new Headers(),
    rawSize: raw.length,
    setReject: (reason) => {
      rejected.push(reason);
    },
    forward: async () => ({ messageId: "" }),
    reply: async () => ({ messageId: "" }),
  };

  await target.email(message, bindings, ctx);
  await waitOnExecutionContext(ctx);

  return rejected;
}

export async function mcp(method: string, params = {}, bindings: Env = env) {
  const response = await request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  }, bindings);

  return response.json<{ result: { tools: { name: string }[]; content: { text: string }[] } }>();
}

export async function inbox() {
  const [summary] = (await (await request("/emails?direction=in&include=suspicious")).json<Types.ListResult>()).emails;

  return (await request(`/emails/${summary?.id ?? ""}?html=true`)).json<Types.Email>();
}

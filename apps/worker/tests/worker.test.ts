import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { inbox, JEV, mcp, post, RAW, READ, receive, request, worker } from "./client";
import { makeOutbox, SendError } from "./fakes";
import type * as Types from "../src/worker.types";

describe("auth", () => {
  test("guards everything but /health with the token", async () => {
    const health = await worker.fetch(new Request("https://mail.test/health"), env, createExecutionContext());
    const missing = await worker.fetch(new Request("https://mail.test/emails"), env, createExecutionContext());
    const wrong = await request("/emails", { headers: { authorization: "Bearer nope" } });

    expect(health.status).toBe(200);
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  test("refuses to serve with a short or shared token, or JEV on without a key", async () => {
    const short = await request("/emails", { headers: { authorization: "Bearer short" } }, { ...env, AGENTS_MAIL_TOKEN: "short" });
    const shared = await request("/emails", {}, { ...env, AGENTS_MAIL_READ_TOKEN: env.AGENTS_MAIL_TOKEN });
    const keyless = await request("/emails", {}, { ...JEV, AGENTS_MAIL_JEV_KEY: "" });

    expect([short.status, shared.status, keyless.status]).toEqual([503, 503, 503]);
  });

  test("a read-only token can read but not write, over REST and MCP", async () => {
    const headers = { authorization: `Bearer ${READ.AGENTS_MAIL_READ_TOKEN}` };
    const list = await request("/emails", { headers }, READ);

    const write = await request("/emails", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    }, READ);

    const tools = await request("/mcp", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    }, READ);

    const names = (await tools.json<{ result: { tools: { name: string }[] } }>()).result.tools.map((tool) => tool.name);

    expect(list.status).toBe(200);
    expect(write.status).toBe(403);
    expect(names).toEqual(["list_emails", "get_email", "wait_for_email"]);
  });
});

describe("emails", () => {
  test("stores, reads, downloads and deletes a received email", async () => {
    await receive();

    const list = await (await request("/emails?direction=in")).json<Types.ListResult>();

    expect(list.total).toBe(1);
    expect(list.emails[0]).toMatchObject({
      from: "jane@example.org",
      to: "inbox@example.com",
      attachments: 1,
    });

    const id = list.emails[0]?.id ?? "";
    const email = await (await request(`/emails/${id}`)).json<Types.Email>();

    expect(email).toMatchObject({
      messageId: "<abc@example.org>",
      subject: "Invoice 100% paid",
      text: "Hello from Jane\n",
    });

    const file = await request(`/emails/${id}/attachments/${email.attachments[0]?.id ?? ""}`);

    expect((await file.text()).trim()).toBe("attached text");
    expect(file.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''note.txt");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("content-security-policy")).toContain("sandbox");

    expect((await request(`/emails/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await request(`/emails/${id}`)).status).toBe(404);
    expect((await env.BUCKET.list({ prefix: `${id}/` })).objects).toHaveLength(0);
  });

  test("searches with literal wildcards, long queries and date filters", async () => {
    await receive();
    await receive(RAW.replace("Invoice 100% paid", "Invoice 1000 paid"));

    const exact = await (await request("/emails?q=100%25")).json<Types.ListResult>();
    const none = await (await request(`/emails?after=${new Date(Date.now() + 60_000).toISOString()}`)).json<Types.ListResult>();
    const long = await request(`/emails?q=${"a".repeat(120)}`);

    expect(exact.total).toBe(1);
    expect(none.total).toBe(0);
    expect(long.status).toBe(200);
  });

  test("rejects invalid input", async () => {
    const many = Array.from({ length: 20 }, (_, index) => `r${index}@example.org`);

    expect((await post("/emails", { to: "bob@example.org", subject: "No body" })).status).toBe(400);
    expect((await post("/emails", {
      to: "Alice <a@example.org>, Bob <b@example.org>",
      subject: "Two in one",
      text: "x",
    })).status).toBe(400);
    expect((await post("/emails", {
      to: "bob@example.org",
      subject: "Line\r\nBcc: eve@example.org",
      text: "x",
    })).status).toBe(400);
    expect((await post("/emails", {
      from: "ceo@other.example",
      to: "bob@example.org",
      subject: "Hi",
      text: "x",
    })).status).toBe(400);
    expect((await post("/emails", {
      to: many,
      cc: many,
      bcc: many,
      subject: "Hi",
      text: "x",
    })).status).toBe(400);
    expect((await post("/emails", {
      to: `x${" ".repeat(100_000)}!`,
      subject: "Hi",
      text: "x",
    })).status).toBe(400);
    expect((await request("/emails?limit=500")).status).toBe(400);
    expect((await request("/emails/not-a-uuid")).status).toBe(400);
  });

  test("answers 404 for unknown emails", async () => {
    const id = crypto.randomUUID();

    const responses = await Promise.all([
      request(`/emails/${id}`),
      request(`/emails/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      request(`/emails/${id}`, { method: "DELETE" }),
      post(`/emails/${id}/reply`, { text: "x" }),
      post(`/emails/${id}/forward`, { to: "boss@example.org" }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
  });
});

describe("send", () => {
  test("sends and stores an outbound email", async () => {
    const outbox = makeOutbox();

    const response = await post("/emails", {
      to: ["Bob <bob@example.org>", "ann@example.org"],
      subject: "Hi",
      text: "Hello Bob",
    }, { ...env, EMAIL: outbox.binding });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ stored: true });
    expect(outbox.messages[0]).toMatchObject({ from: { name: "Agent", email: "agent@example.com" }, to: [{ name: "Bob", email: "bob@example.org" }, "ann@example.org"] });

    const list = await (await request("/emails?direction=out&to=ANN@example.org")).json<Types.ListResult>();

    expect(list.emails[0]).toMatchObject({ from: "agent@example.com", subject: "Hi" });
  });

  test("builds the text part from html when text is left out", async () => {
    const outbox = makeOutbox();

    const response = await post("/emails", {
      to: "bob@example.org",
      subject: "Report",
      html: "<h1>Report</h1><p>All <strong>green</strong>.</p>",
    }, { ...env, EMAIL: outbox.binding });

    const { id } = await response.json<Types.SendResult>();
    const email = await (await request(`/emails/${id}`)).json<Types.Email>();

    expect(outbox.messages[0]).toHaveProperty("text", expect.stringContaining("All green."));
    expect(email.text).toContain("All green.");
  });

  test("sends and stores attachments, within the size limit", async () => {
    const outbox = makeOutbox();
    const bindings = { ...env, EMAIL: outbox.binding };

    const small = await post("/emails", {
      to: "bob@example.org",
      subject: "File",
      text: "x",
      attachments: [{ filename: "a.txt", type: "text/plain", content: btoa("hello") }],
    }, bindings);

    const { id } = await small.json<Types.SendResult>();
    const email = await (await request(`/emails/${id}`)).json<Types.Email>();

    const big = await post("/emails", {
      to: "bob@example.org",
      subject: "Big",
      text: "x",
      attachments: [{ filename: "b.bin", type: "application/octet-stream", content: btoa("x".repeat(5_300_000)) }],
    }, bindings);

    expect(outbox.messages[0]).toHaveProperty("attachments.length", 1);
    expect(email.attachments[0]).toMatchObject({ filename: "a.txt", size: 5 });
    expect(big.status).toBe(400);
  });

  test("turns Cloudflare send errors into actionable responses", async () => {
    const outbox = makeOutbox(new SendError("Sender domain not verified", "E_SENDER_NOT_VERIFIED"));

    const response = await post("/emails", {
      to: "bob@example.org",
      subject: "Hi",
      text: "Hello",
    }, { ...env, EMAIL: outbox.binding });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Sender domain not verified", code: "E_SENDER_NOT_VERIFIED" });
  });
});

describe("threads", () => {
  test("replies in the thread from the address that received the mail", async () => {
    const outbox = makeOutbox();

    await receive(RAW
      .replace("To: inbox@example.com", "To: signup@example.com, carl@example.org")
      .replace("Message-ID: <abc@example.org>", "Message-ID: <abc@example.org>\r\nReferences: <root@example.org>"));

    const email = await inbox();
    const response = await post(`/emails/${email.id}/reply`, { text: "Thanks", all: true }, { ...env, EMAIL: outbox.binding });
    const redirected = await post(`/emails/${email.id}/reply`, { text: "Hi", to: "boss@example.org" }, { ...env, EMAIL: outbox.binding });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ to: "jane@example.org", cc: "carl@example.org" });
    expect(await redirected.json()).toMatchObject({ to: "boss@example.org", cc: null });
    expect(outbox.messages[0]).toMatchObject({
      from: "inbox@example.com",
      to: ["jane@example.org"],
      cc: ["carl@example.org"],
      subject: "Re: Invoice 100% paid",
      headers: { "In-Reply-To": "<abc@example.org>", "References": "<root@example.org> <abc@example.org>" },
    });

    const thread = await (await request(`/emails?thread=${encodeURIComponent("<root@example.org>")}`)).json<Types.ListResult>();

    expect(thread.total).toBe(3);
  });

  test("refuses to send stored headers that break the rules", async () => {
    await receive(RAW.replace("Subject: Invoice 100% paid", `Subject: =?UTF-8?B?${btoa("Hi\r\nBcc: eve@example.org")}?=`));

    const response = await post(`/emails/${(await inbox()).id}/reply`, { text: "x" }, { ...env, EMAIL: makeOutbox().binding });

    expect(response.status).toBe(400);
  });

  test("forwards an email with its attachments", async () => {
    const outbox = makeOutbox();

    await receive();

    const email = await inbox();

    const response = await post(`/emails/${email.id}/forward`, { to: "boss@example.org", text: "FYI" }, { ...env, EMAIL: outbox.binding });
    const { id, stored } = await response.json<Types.SendResult>();
    const forwarded = await (await request(`/emails/${id}`)).json<Types.Email>();

    expect(stored).toBe(true);
    expect(forwarded.attachments).toMatchObject([{ filename: "note.txt" }]);
    expect(outbox.messages[0]).toMatchObject({
      to: ["boss@example.org"],
      subject: "Fwd: Invoice 100% paid",
      text: expect.stringContaining("---------- Forwarded message ---------"),
    });
    expect(outbox.messages[0]).toHaveProperty("attachments.length", 1);
  });
});

describe("mcp", () => {
  test("only accepts POST", async () => {
    expect((await request("/mcp")).status).toBe(405);
  });

  test("lists tools and calls them statelessly", async () => {
    const tools = await mcp("tools/list");

    expect(tools.result.tools.map((tool) => tool.name)).toEqual([
      "list_emails",
      "get_email",
      "wait_for_email",
      "send_email",
      "reply_email",
      "forward_email",
      "mark_email",
      "delete_email",
    ]);

    await receive();

    const call = await mcp("tools/call", { name: "list_emails", arguments: { q: "Jane" } });

    expect(JSON.parse(call.result.content[0]?.text ?? "")).toMatchObject({ total: 1 });
  });
});

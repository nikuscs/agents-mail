import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { except } from "hono/combine";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { timingSafeEqual } from "hono/utils/buffer";
import { makeMail } from "./mail";
import * as Constants from "./worker.constants";
import * as Types from "./worker.types";
import * as Utils from "./worker.utils";

function makeMcp(env: Env, deps: Types.Deps, scope: Types.Scope) {
  const mail = makeMail(env, deps);
  const server = new McpServer({ name: "agents-mail", version: Constants.VERSION });

  server.registerTool("list_emails", {
    description: "List and search stored emails, newest first. `status: unread` shows only new mail.",
    inputSchema: Types.listParams,
    annotations: { readOnlyHint: true },
  }, async (params) => Utils.guard(async () => Utils.reply(await mail.list(params))));

  server.registerTool("get_email", {
    description: "Get one email with its text, addressing, extracted code and link, and attachment list. Flagged or unscored mail needs `include: suspicious`; raw `html` only with `html: true`, and JEV does not screen it.",
    inputSchema: Types.getParams,
    annotations: { readOnlyHint: true },
  }, async (params) => Utils.guard(async () => {
    const email = await mail.get(params);

    return email ? Utils.reply(email) : Utils.fail("Email not found.");
  }));

  server.registerTool("wait_for_email", {
    description: "Wait for a new email to arrive, e.g. a signup confirmation, or a reply in a `thread` (found even if it already arrived). Returns it with any extracted `code` and `link`.",
    inputSchema: Types.waitParams,
    annotations: { readOnlyHint: true },
  }, async (params) => Utils.guard(async () => {
    const email = await mail.wait(params);

    return email ? Utils.reply(email) : Utils.fail("No matching email arrived in time.");
  }));

  if (scope === "read") {
    return server;
  }

  server.registerTool("send_email", {
    description: "Send an email. `from` defaults to the configured sender. Pass several recipients as an array; attachments are base64.",
    inputSchema: Types.sendParams,
  }, async (params) => Utils.guard(async () => Utils.reply(await mail.send(params))));

  server.registerTool("reply_email", {
    description: "Reply to an email in the same thread, from the address it was delivered to. It goes to the email's Reply-To or From, which its sender controls: show the user the returned `to` and `cc`, or pass `to` yourself. `all` also copies the other recipients.",
    inputSchema: Types.replyParams,
  }, async (params) => Utils.guard(async () => {
    const result = await mail.reply(params);

    return result ? Utils.reply(result) : Utils.fail("Email not found.");
  }));

  server.registerTool("forward_email", {
    description: "Forward an email with its attachments, optionally with a note.",
    inputSchema: Types.forwardParams,
  }, async (params) => Utils.guard(async () => {
    const result = await mail.forward(params);

    return result ? Utils.reply(result) : Utils.fail("Email not found.");
  }));

  server.registerTool("mark_email", {
    description: "Mark an email as read (default) or unread.",
    inputSchema: Types.markParams,
    annotations: { idempotentHint: true },
  }, async (params) => Utils.guard(async () => (await mail.mark(params) ? Utils.reply({ read: params.read }) : Utils.fail("Email not found."))));

  server.registerTool("delete_email", {
    description: "Delete an email and its attachments.",
    inputSchema: Types.destroyParams,
    annotations: { destructiveHint: true },
  }, async (params) => Utils.guard(async () => {
    const deleted = await mail.destroy(params);

    return deleted ? Utils.reply({ deleted }) : Utils.fail("Email not found.");
  }));

  return server;
}

const write = createMiddleware<Types.AppEnv>(async (c, next) => {
  if (c.get("scope") !== "full") {
    throw Utils.problem(403, "This token is read-only.");
  }

  await next();
});

function makeApp(deps: Types.Deps) {
  return new Hono<Types.AppEnv>()
    .use(except("/health", async (c, next) => {
      const { AGENTS_MAIL_TOKEN: full = "", AGENTS_MAIL_READ_TOKEN: read = "" } = c.env;

      if (full.length < Constants.MIN_TOKEN || (read && read.length < Constants.MIN_TOKEN)) {
        throw Utils.problem(503, `AGENTS_MAIL_TOKEN and AGENTS_MAIL_READ_TOKEN must be at least ${Constants.MIN_TOKEN} characters.`);
      }

      if (read === full) {
        throw Utils.problem(503, "AGENTS_MAIL_READ_TOKEN must differ from AGENTS_MAIL_TOKEN.");
      }

      if (c.env.AGENTS_MAIL_JEV === "true" && !c.env.AGENTS_MAIL_JEV_KEY) {
        throw Utils.problem(503, "AGENTS_MAIL_JEV is true but AGENTS_MAIL_JEV_KEY is empty.");
      }

      return bearerAuth({
        verifyToken: async (token) => {
          if (await timingSafeEqual(token, full)) {
            c.set("scope", "full");

            return true;
          }

          if (read && await timingSafeEqual(token, read)) {
            c.set("scope", "read");

            return true;
          }

          return false;
        },
      })(c, next);
    }))
    .use(bodyLimit({ maxSize: Constants.MAX_BODY, onError: (c) => c.json({ error: "Request body too large" }, 413) }))
    .get("/health", (c) => c.json({ ok: true }))
    .get("/emails", async (c) => {
      const result = await makeMail(c.env, deps).list(Types.listParams.parse(c.req.query()));

      return c.json(result);
    })
    .post("/emails", write, async (c) => {
      const result = await makeMail(c.env, deps).send(Types.sendParams.parse(await c.req.json()));

      return c.json(result, 201);
    })
    .get("/emails/wait", async (c) => {
      const email = await makeMail(c.env, deps).wait(Types.waitParams.parse(c.req.query()));

      return email ? c.json(email) : c.json({ error: "No matching email arrived in time." }, 408);
    })
    .get("/emails/:id", async (c) => {
      const email = await makeMail(c.env, deps).get(Types.getParams.parse({ ...c.req.query(), id: c.req.param("id") }));

      return email ? c.json(email) : c.notFound();
    })
    .patch("/emails/:id", write, async (c) => {
      const marked = await makeMail(c.env, deps).mark(Types.markParams.parse({ ...await c.req.json(), id: c.req.param("id") }));

      return marked ? c.body(null, 204) : c.notFound();
    })
    .delete("/emails/:id", write, async (c) => {
      const deleted = await makeMail(c.env, deps).destroy(Types.destroyParams.parse(c.req.param()));

      return deleted ? c.body(null, 204) : c.notFound();
    })
    .post("/emails/:id/reply", write, async (c) => {
      const result = await makeMail(c.env, deps).reply(Types.replyParams.parse({ ...await c.req.json(), id: c.req.param("id") }));

      return result ? c.json(result, 201) : c.notFound();
    })
    .post("/emails/:id/forward", write, async (c) => {
      const result = await makeMail(c.env, deps).forward(Types.forwardParams.parse({ ...await c.req.json(), id: c.req.param("id") }));

      return result ? c.json(result, 201) : c.notFound();
    })
    .get("/emails/:id/attachments/:attachment", async (c) => {
      const object = await makeMail(c.env, deps).download(Types.downloadParams.parse(c.req.param()));

      if (!object) {
        return c.notFound();
      }

      const headers = new Headers({ ...Constants.DOWNLOAD_HEADERS, etag: object.httpEtag });

      object.writeHttpMetadata(headers);

      return new Response(object.body, { headers });
    })
    .post("/mcp", async (c) => {
      const body = await c.req.json();

      if (Array.isArray(body) && body.length > Constants.MAX_BATCH) {
        throw Utils.problem(400, `Send at most ${Constants.MAX_BATCH} MCP messages per request.`);
      }

      const transport = new StreamableHTTPTransport({ enableJsonResponse: true });

      await makeMcp(c.env, deps, c.get("scope")).connect(transport);

      return (await transport.handleRequest(c, body)) ?? c.body(null, 202);
    })
    .all("/mcp", (c) => c.json({ error: "Method not allowed" }, 405))
    .notFound((c) => c.json({ error: "Not found" }, 404))
    .onError((error, c) => {
      if (error instanceof HTTPException) {
        return error.getResponse();
      }

      if (error instanceof Types.ZodError) {
        return c.json({ error: Types.prettifyError(error) }, 400);
      }

      if (error instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      Utils.log("Request failed", error);

      return c.json({ error: "Internal server error" }, 500);
    });
}

export function makeWorker(deps: Types.Deps = {}) {
  return {
    fetch: makeApp(deps).fetch,
    email: async (message, env, ctx) => {
      const mail = makeMail(env, deps);
      const email = await mail.receive(message);

      if (email) {
        ctx.waitUntil(mail.categorize(email));
      }
    },
    scheduled: async (_controller, env) => {
      await makeMail(env, deps).purge();
    },
  } satisfies ExportedHandler<Env>;
}

export default makeWorker();

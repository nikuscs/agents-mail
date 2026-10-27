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

function makeMcp(env: Env, deps: Types.WorkerDeps, scope: Types.WorkerScope) {
  const mail = makeMail(env, deps);
  const server = new McpServer({ name: "agents-mail", version: Constants.WORKER_VERSION });

  server.registerTool("list_emails", {
    description: "List and search stored emails, newest first. `status: unread` shows only new mail.",
    inputSchema: Types.workerListParams,
    annotations: { readOnlyHint: true },
  }, async (params) => Utils.workerGuard(async () => Utils.workerReply(await mail.list(params))));

  server.registerTool("get_email", {
    description: "Get one email with its text, addressing, extracted code and link, and attachment list. Flagged or unscored mail needs `include: suspicious`; raw `html` only with `html: true`, and JEV does not screen it.",
    inputSchema: Types.workerGetParams,
    annotations: { readOnlyHint: true },
  }, async (params) => Utils.workerGuard(async () => {
    const email = await mail.get(params);

    return email ? Utils.workerReply(email) : Utils.workerFail("Email not found.");
  }));

  server.registerTool("wait_for_email", {
    description: "Wait for a new email to arrive, e.g. a signup confirmation, or a reply in a `thread` (found even if it already arrived). Returns it with any extracted `code` and `link`.",
    inputSchema: Types.workerWaitParams,
    annotations: { readOnlyHint: true },
  }, async (params) => Utils.workerGuard(async () => {
    const email = await mail.wait(params);

    return email ? Utils.workerReply(email) : Utils.workerFail("No matching email arrived in time.");
  }));

  if (scope === "read") {
    return server;
  }

  server.registerTool("send_email", {
    description: "Send an email. `from` defaults to the configured sender. Pass several recipients as an array; attachments are base64.",
    inputSchema: Types.workerSendParams,
  }, async (params) => Utils.workerGuard(async () => Utils.workerReply(await mail.send(params))));

  server.registerTool("reply_email", {
    description: "Reply to an email in the same thread, from the address it was delivered to. It goes to the email's Reply-To or From, which its sender controls: show the user the returned `to` and `cc`, or pass `to` yourself. `all` also copies the other recipients.",
    inputSchema: Types.workerReplyParams,
  }, async (params) => Utils.workerGuard(async () => {
    const result = await mail.reply(params);

    return result ? Utils.workerReply(result) : Utils.workerFail("Email not found.");
  }));

  server.registerTool("forward_email", {
    description: "Forward an email with its attachments, optionally with a note.",
    inputSchema: Types.workerForwardParams,
  }, async (params) => Utils.workerGuard(async () => {
    const result = await mail.forward(params);

    return result ? Utils.workerReply(result) : Utils.workerFail("Email not found.");
  }));

  server.registerTool("mark_email", {
    description: "Mark an email as read (default) or unread.",
    inputSchema: Types.workerMarkParams,
    annotations: { idempotentHint: true },
  }, async (params) => Utils.workerGuard(async () => (await mail.mark(params) ? Utils.workerReply({ read: params.read }) : Utils.workerFail("Email not found."))));

  server.registerTool("delete_email", {
    description: "Delete an email and its attachments.",
    inputSchema: Types.workerDestroyParams,
    annotations: { destructiveHint: true },
  }, async (params) => Utils.workerGuard(async () => {
    const deleted = await mail.destroy(params);

    return deleted ? Utils.workerReply({ deleted }) : Utils.workerFail("Email not found.");
  }));

  return server;
}

const write = createMiddleware<Types.WorkerAppEnv>(async (c, next) => {
  if (c.get("scope") !== "full") {
    throw Utils.workerProblem(403, "This token is read-only.");
  }

  await next();
});

function makeApp(deps: Types.WorkerDeps) {
  return new Hono<Types.WorkerAppEnv>()
    .use(except("/health", async (c, next) => {
      const { AGENTS_MAIL_TOKEN: full = "", AGENTS_MAIL_READ_TOKEN: read = "" } = c.env;

      if (full.length < Constants.WORKER_MIN_TOKEN || (read && read.length < Constants.WORKER_MIN_TOKEN)) {
        throw Utils.workerProblem(503, `AGENTS_MAIL_TOKEN and AGENTS_MAIL_READ_TOKEN must be at least ${Constants.WORKER_MIN_TOKEN} characters.`);
      }

      if (read === full) {
        throw Utils.workerProblem(503, "AGENTS_MAIL_READ_TOKEN must differ from AGENTS_MAIL_TOKEN.");
      }

      if (c.env.AGENTS_MAIL_JEV === "true" && !c.env.AGENTS_MAIL_JEV_KEY) {
        throw Utils.workerProblem(503, "AGENTS_MAIL_JEV is true but AGENTS_MAIL_JEV_KEY is empty.");
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
    .use(bodyLimit({ maxSize: Constants.WORKER_MAX_BODY, onError: (c) => c.json({ error: "Request body too large" }, 413) }))
    .get("/health", (c) => c.json({ ok: true }))
    .get("/emails", async (c) => {
      const result = await makeMail(c.env, deps).list(Types.workerListParams.parse(c.req.query()));

      return c.json(result);
    })
    .post("/emails", write, async (c) => {
      const result = await makeMail(c.env, deps).send(Types.workerSendParams.parse(await c.req.json()));

      return c.json(result, 201);
    })
    .get("/emails/wait", async (c) => {
      const email = await makeMail(c.env, deps).wait(Types.workerWaitParams.parse(c.req.query()));

      return email ? c.json(email) : c.json({ error: "No matching email arrived in time." }, 408);
    })
    .get("/emails/:id", async (c) => {
      const email = await makeMail(c.env, deps).get(Types.workerGetParams.parse({ ...c.req.query(), id: c.req.param("id") }));

      return email ? c.json(email) : c.notFound();
    })
    .patch("/emails/:id", write, async (c) => {
      const marked = await makeMail(c.env, deps).mark(Types.workerMarkParams.parse({ ...await c.req.json(), id: c.req.param("id") }));

      return marked ? c.body(null, 204) : c.notFound();
    })
    .delete("/emails/:id", write, async (c) => {
      const deleted = await makeMail(c.env, deps).destroy(Types.workerDestroyParams.parse(c.req.param()));

      return deleted ? c.body(null, 204) : c.notFound();
    })
    .post("/emails/:id/reply", write, async (c) => {
      const result = await makeMail(c.env, deps).reply(Types.workerReplyParams.parse({ ...await c.req.json(), id: c.req.param("id") }));

      return result ? c.json(result, 201) : c.notFound();
    })
    .post("/emails/:id/forward", write, async (c) => {
      const result = await makeMail(c.env, deps).forward(Types.workerForwardParams.parse({ ...await c.req.json(), id: c.req.param("id") }));

      return result ? c.json(result, 201) : c.notFound();
    })
    .get("/emails/:id/attachments/:attachment", async (c) => {
      const object = await makeMail(c.env, deps).download(Types.workerDownloadParams.parse(c.req.param()));

      if (!object) {
        return c.notFound();
      }

      const headers = new Headers({ ...Constants.WORKER_DOWNLOAD_HEADERS, etag: object.httpEtag });

      object.writeHttpMetadata(headers);

      return new Response(object.body, { headers });
    })
    .post("/mcp", async (c) => {
      const body = await c.req.json();

      if (Array.isArray(body) && body.length > Constants.WORKER_MAX_BATCH) {
        throw Utils.workerProblem(400, `Send at most ${Constants.WORKER_MAX_BATCH} MCP messages per request.`);
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

      if (error instanceof Types.WorkerZodError) {
        return c.json({ error: Types.workerPrettifyError(error) }, 400);
      }

      if (error instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      Utils.workerLog("Request failed", error);

      return c.json({ error: "Internal server error" }, 500);
    });
}

export function makeWorker(deps: Types.WorkerDeps = {}) {
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

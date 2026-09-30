#!/usr/bin/env bun
import { $ } from "bun";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import config from "../apps/worker/wrangler.jsonc";

const NAME = config.name;
const DATABASE = config.d1_databases[0].database_name;
const BUCKET = config.r2_buckets[0].bucket_name;
const APP = join(import.meta.dir, "../apps/worker");
const SECRETS = join(APP, ".prod.vars");
const DEPLOY_CONFIG = join(APP, ".wrangler/deploy.jsonc");
const CATCH_ALL = JSON.stringify([{ type: "worker", value: [NAME] }]);
const SENDER = /^(?:[^"<>\r\n]*<[^\s"<>@]+@[^\s"<>@]+\.[^\s"<>@]+>|[^\s"<>@]+@[^\s"<>@]+\.[^\s"<>@]+)$/;
const SAFE_VALUE = /^[^\s"'\\]*$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const skipped: string[] = [];

$.cwd(APP);
$.env({
  ...process.env,
  FORCE_COLOR: "0",
});

function stop(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function step(message: string) {
  console.log(`\n▸ ${message}`);
}

function ask(message: string): boolean {
  const answer = confirm(`\n? ${message}`);

  if (!answer) {
    skipped.push(message);
  }

  return answer;
}

async function ok(command: string[]): Promise<boolean> {
  const { exitCode } = await $`bunx ${command}`.nothrow().quiet();

  return exitCode === 0;
}

async function login() {
  step("Cloudflare login");

  if (!(await ok(["wrangler", "whoami", "--json"]))) {
    await $`bunx wrangler login`;
  }

  if (!(await ok(["cf", "auth", "whoami"]))) {
    await $`bunx cf auth login`;
  }

  console.log("Logged in to wrangler and cf.");
}

async function configure() {
  step("Configuration");

  const from = prompt("? Sender address, e.g. Agent <agent@yourdomain.com>:")?.trim() ?? "";

  if (!SENDER.test(from)) {
    stop("Use one address like `agent@yourdomain.com` or `Agent <agent@yourdomain.com>`, without quotes.");
  }

  const jev = confirm("? Label incoming mail and flag prompt injection with TypeSafe JEV? (needs an API key)");
  const key = jev ? prompt("? TypeSafe API key:")?.trim() ?? "" : "";

  if (!SAFE_VALUE.test(key) || (jev && !key)) {
    stop("The TypeSafe API key is empty or has spaces or quotes.");
  }

  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");

  await writeFile(SECRETS, `AGENTS_MAIL_TOKEN=${token}\nAGENTS_MAIL_READ_TOKEN=\nAGENTS_MAIL_FROM="${from}"\nAGENTS_MAIL_JEV=${jev}\nAGENTS_MAIL_JEV_KEY=${key}\n`, { mode: 0o600, flag: "wx" });

  console.log("Saved apps/worker/.prod.vars with a new random AGENTS_MAIL_TOKEN. It is gitignored; keep it private.");
}

async function secrets() {
  if (!(await Bun.file(SECRETS).exists())) {
    await configure();
  }

  const {
    AGENTS_MAIL_TOKEN: token = "",
    AGENTS_MAIL_READ_TOKEN: read = "",
    AGENTS_MAIL_FROM: from = "",
    AGENTS_MAIL_JEV: jev = "",
    AGENTS_MAIL_JEV_KEY: key = "",
  } = parseEnv(await Bun.file(SECRETS).text());
  const address = /<([^<>]+)>\s*$/.exec(from)?.[1] ?? from;
  const domain = address.split("@").at(-1)?.replace(/\.$/, "").toLowerCase();

  if (token.length < 32 || (read && read.length < 32) || !SENDER.test(from) || !domain || !DOMAIN.test(domain)) {
    stop("apps/worker/.prod.vars needs AGENTS_MAIL_TOKEN (32+ chars), AGENTS_MAIL_FROM and an empty or 32+ char AGENTS_MAIL_READ_TOKEN. Delete the file and rerun to recreate it.");
  }

  if (read === token) {
    stop("AGENTS_MAIL_READ_TOKEN must differ from AGENTS_MAIL_TOKEN in apps/worker/.prod.vars.");
  }

  if (jev === "true" && !key) {
    stop("AGENTS_MAIL_JEV is true but AGENTS_MAIL_JEV_KEY is empty in apps/worker/.prod.vars.");
  }

  return { domain };
}

async function zone(domain: string): Promise<string> {
  const zones = await $`bunx cf zones list --name=${domain}`.nothrow().quiet().json().catch(() => []);
  const id = zones.find((item) => item.name === domain)?.id;

  if (typeof id !== "string") {
    stop(`${domain} is not a Cloudflare zone on this account. Add the domain to Cloudflare first.`);
  }

  return id;
}

async function database() {
  step(`D1 database ${DATABASE}`);

  if (!(await ok(["wrangler", "d1", "info", DATABASE]))) {
    await $`bunx wrangler d1 create ${DATABASE} --update-config=false`;
  }

  await $`bunx wrangler d1 migrations apply DB --remote`;
}

async function bucket() {
  step(`R2 bucket ${BUCKET}`);

  if (!(await ok(["wrangler", "r2", "bucket", "info", BUCKET]))) {
    await $`bunx wrangler r2 bucket create ${BUCKET} --update-config=false`;
  }
}

async function deploy(): Promise<string> {
  step(`Worker ${NAME}`);

  const { uuid } = await $`bunx wrangler d1 info ${DATABASE} --json`.quiet().json();
  const [binding] = config.d1_databases;

  await mkdir(dirname(DEPLOY_CONFIG), { recursive: true });
  await writeFile(DEPLOY_CONFIG, JSON.stringify({
    ...config,
    $schema: undefined,
    main: join(APP, config.main),
    d1_databases: [{ ...binding, database_id: uuid, migrations_dir: join(APP, binding.migrations_dir) }],
  }));

  const output = await $`bunx wrangler deploy --config ${DEPLOY_CONFIG} --secrets-file ${SECRETS}`.text().finally(async () => rm(DEPLOY_CONFIG, { force: true }));

  console.log(output.trim());

  return /https:\/\/[\w.-]+\.workers\.dev/.exec(output)?.[0] ?? `https://${NAME}.<your-subdomain>.workers.dev`;
}

async function sending(domain: string, id: string) {
  step(`Email Sending on ${domain}`);

  const subdomains = await $`bunx cf email-sending subdomains list -z ${id}`.quiet().json();

  if (subdomains.some((subdomain) => subdomain.name === domain && subdomain.enabled)) {
    console.log("Already enabled.");

    return;
  }

  if (ask(`Enable Email Sending on ${domain}? Cloudflare adds SPF and DKIM DNS records.`)) {
    await $`bunx cf email-sending subdomains create -z ${id} --name=${domain}`.quiet();
  }
}

async function routing(domain: string, id: string) {
  step(`Email Routing on ${domain}`);

  const settings = await $`bunx cf email-routing settings get -z ${id}`.quiet().json();

  if (settings.enabled === true) {
    console.log("Already enabled.");

    return;
  }

  if (ask(`Enable Email Routing on ${domain}? This replaces its MX records, so any other mail provider there stops receiving.`)) {
    await $`bunx cf email-routing enable -z ${id} --name=${domain}`.quiet();
  }
}

async function catchall(domain: string, id: string) {
  step(`Catch-all rule on ${domain}`);

  const rule = await $`bunx cf email-routing rules catch-all get -z ${id}`.quiet().json();
  const current = JSON.stringify(rule.actions);

  if (rule.enabled === true && current === CATCH_ALL) {
    console.log(`Already sends everything to ${NAME}.`);

    return;
  }

  console.log(`Current: ${rule.enabled === true ? "enabled" : "disabled"}, actions ${current}`);

  if (ask(`Replace this catch-all so every address on ${domain} goes to the ${NAME} worker?`)) {
    await $`bunx cf email-routing rules catch-all update -z ${id} --enabled --actions ${CATCH_ALL} --matchers ${JSON.stringify([{ type: "all" }])}`.quiet();
  }
}

await login();

const { domain } = await secrets();
const id = await zone(domain);

await database();
await bucket();

const url = await deploy();

await sending(domain, id);
await routing(domain, id);
await catchall(domain, id);

if (skipped.length > 0) {
  console.log(`\n⚠ agents-mail is deployed, but setup is not finished. Skipped:\n${skipped.map((item) => `  - ${item}`).join("\n")}\nRerun \`bun run deploy\` and answer y.`);
  process.exit(1);
}

console.log(`
✔ agents-mail is live at ${url}. Mail to any address on ${domain} lands here.

Connect your agent (run from the repo root):

  claude mcp add --transport http agents-mail ${url}/mcp --header "Authorization: Bearer $(sed -n 's/^AGENTS_MAIL_TOKEN=//p' apps/worker/.prod.vars)"

Or use it with curl and the agents-mail skill:

  export AGENTS_MAIL_URL=${url}
  export AGENTS_MAIL_TOKEN="$(sed -n 's/^AGENTS_MAIL_TOKEN=//p' apps/worker/.prod.vars)"
`);

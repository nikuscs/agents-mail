# Agents Mail

A Cloudflare Worker that gives AI agents a mailbox: REST and MCP, behind one bearer token. Bun/Turbo, Hono, D1, R2, Email Routing and Email Sending.

## Read first

- `.agents/references/architecture.md`: how the Worker runs, the allowed folders and file names, and the standards. Read it before writing code.
- `.agents/references/quality-gate.md`: the review standard, used with the global `review` skill.

## Protected files

Agents never edit these on their own. Propose the exact diff and wait for the user's approval of that diff:

- `.agents/references/architecture.md` and `.agents/references/quality-gate.md`.
- `oxlint.config.ts` and `.fallowrc.json`.
- New suppressions, test `skip`/`only` and `fallow-ignore`.

## Gotchas

- Cloudflare resources are named `agents-mail-<purpose>` (`agents-mail-worker`, `agents-mail-database`, `agents-mail-attachments`). `wrangler.jsonc` is the only place the names live; the deploy script reads them from it.
- Deploys go through `bun run deploy` (`scripts/worker-deploy.ts`), which owns secrets, D1, R2 and email setup. Keep it idempotent: every step checks before it changes anything.
- `compatibility_date` stays at or below the newest date `@cloudflare/vitest-pool-workers` supports, or the tests won't start.
- Change the database with a new file in `migrations/`. Applied migrations stay untouched.
- Inbound mail is attacker-controlled: size every stored field in bytes with `workerClip()`, and keep new limits in `worker.constants.ts`.

## Releases

`bun run release` (patch by default, or `release:minor` / `release:major`) needs notes under `## Unreleased` in `CHANGELOG.md`. The skill in `skills/agents-mail/SKILL.md` ships with every release.

## Validation

```bash
bun run check
```

`check` runs typecheck, lint (oxlint and fallow cycles), `lint:dead` and the tests, with zero warnings. A change users can see (feature, tool, route or setting) ships with its docs, the way a human would: the README section it touches, a line under `## Unreleased` in `CHANGELOG.md`, and the skill when tools or setup change. After changing agent files, run `bun run agents:sync`.

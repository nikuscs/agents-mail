# Agents Mail

A Cloudflare Worker that gives AI agents a mailbox: REST and MCP, behind one bearer token.

## Code

- The Worker is `apps/worker/src/worker.ts`: the layers (`makeDatabase`, `makeStorage`, `makeOutbox`, `makeClassifier`, `makeMail`, `makeMcp`) and the Hono app. Types and zod schemas live in `worker.types.ts`, constants in `worker.constants.ts`, pure helpers in `worker.utils.ts`.
- Method names are single words, Laravel style: `list`, `get`, `send`, `destroy`.
- Types take the method's name: `send()` takes `SendParams` and returns `SendResult`, validated by the `sendParams` schema.
- The code explains itself, so it carries no comments.
- A function with one caller is inlined at that caller, and so is one with two callers and at most 3 lines. The `make*` layers stay: they are the seams tests inject fakes through.

## Tests

- Test the main flows through the Worker's handlers (`fetch`, `email`, `scheduled`, MCP): the happy path plus each error path it has, one test per behaviour. Skip anything the types or zod already guarantee.
- Keep each test small: merge assertions that share setup, and add a test only for a behaviour no other test covers.
- Fake bindings and `fetch` with `tests/fakes.ts`, injected through `makeWorker(deps)` or the env; the suite has no `vi`.
- Every test starts clean: `tests/setup.ts` empties D1 and R2 before each one.

## Gotchas

- Cloudflare resources are named `agents-mail-<purpose>` (`agents-mail-worker`, `agents-mail-database`, `agents-mail-attachments`). `wrangler.jsonc` is the only place the names live; the deploy script reads them from it.
- Deploys go through `bun run deploy` (`scripts/worker-deploy.ts`), which owns secrets, D1, R2 and email setup. Keep it idempotent: every step checks before it changes anything.
- `compatibility_date` stays at or below the newest date `@cloudflare/vitest-pool-workers` supports, or the tests won't start.
- Change the database with a new file in `migrations/`. Applied migrations stay untouched.
- Inbound mail is attacker-controlled: size every stored field in bytes with `clip()`, and keep new limits in `worker.constants.ts`.

## Releases

`bun run release` (patch by default, or `release:minor` / `release:major`) needs notes under `## Unreleased` in `CHANGELOG.md`. The skill in `skills/agents-mail/SKILL.md` ships with every release.

## Done means

- `bun run check && bun run lint && bun run test` pass with zero warnings.
- A change users can see (feature, tool, route or setting) ships with its docs, the way a human would: the README section it touches, a line under `## Unreleased` in `CHANGELOG.md`, and the skill when tools or setup change.

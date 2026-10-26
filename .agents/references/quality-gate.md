# Quality gate

Review the changed files and their callers against `.agents/references/architecture.md`. Report a defect only when the code proves its effect.

## Checks

```sh
bun run check
bunx fallow dead-code --changed-since "$BASE" --format json
```

A required check that cannot run makes the review `INCOMPLETE`.

## Review

- Every added, renamed or moved file matches its tree in the architecture reference.
- Input is parsed once at its boundary; inbound mail fields are clipped in bytes.
- Deploy steps stay idempotent: each checks before it changes anything.
- A user-visible change updates the README, `CHANGELOG.md` and, for tools or setup, `skills/agents-mail/SKILL.md`.
- After a rename, move or replacement, old symbols, files and docs are gone and changed exports still have consumers.

## Protected enforcement

`architecture.md`, this file, `oxlint.config.ts`, `.fallowrc.json`, `tsconfig.json`, `vitest.config.ts`, `turbo.json`, `.github/workflows/**` and package `lint`, `typecheck` and `test` scripts change only for an explicit user request. New suppressions, skipped tests, `fallow-ignore` and downgraded severities are findings.

Use `FAIL` for proven defects and convention violations, `WARN` for optional improvements. Include the file, line, effect and fix direction.

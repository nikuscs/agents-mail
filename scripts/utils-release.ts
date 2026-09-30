#!/usr/bin/env bun
import { $ } from "bun";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const FILES = ["package.json", "apps/worker/package.json", "apps/worker/src/worker.constants.ts", "skills/agents-mail/SKILL.md"];
const BUMPS = ["patch", "minor", "major"];

$.cwd(ROOT);

function stop(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const bump = args.find((arg) => BUMPS.includes(arg)) ?? "patch";

if (args.some((arg) => arg !== "--dry-run" && !BUMPS.includes(arg))) {
  stop("Usage: bun scripts/utils-release.ts [patch|minor|major] [--dry-run]");
}

if ((await $`git branch --show-current`.text()).trim() !== "main") {
  stop("Release from main.");
}

if ((await $`git status --porcelain`.text()).trim() !== "") {
  stop("Commit or stash your changes first.");
}

await $`git fetch origin main --tags`.quiet();

const sha = (await $`git rev-parse HEAD`.text()).trim();

if (sha !== (await $`git rev-parse origin/main`.text()).trim()) {
  stop("main must match origin/main. Pull or push first.");
}

const changelog = await Bun.file(CHANGELOG).text();
const unreleased = /## Unreleased\n([\s\S]*?)(?=\n## |$)/.exec(changelog)?.[1]?.trim();

if (!unreleased) {
  stop("Add release notes under `## Unreleased` in CHANGELOG.md.");
}

await $`bun run check`;
await $`bun run lint`;
await $`bun run test`;

const { version } = await Bun.file(join(ROOT, "package.json")).json();
const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);

const target = {
  patch: `${major}.${minor}.${patch + 1}`,
  minor: `${major}.${minor + 1}.0`,
  major: `${major + 1}.0.0`,
}[bump];

console.log(`\nRelease v${target} (${bump} from v${version}) at ${sha.slice(0, 12)}:\n\n${unreleased}\n`);

if (dry) {
  console.log("Dry run: nothing was changed.");
  process.exit(0);
}

if (!confirm(`? Tag and push v${target}? GitHub Actions then publishes the release.`)) {
  stop("Release cancelled.");
}

await Bun.write(CHANGELOG, changelog.replace("## Unreleased\n", `## Unreleased\n\n## ${target} - ${new Date().toISOString().slice(0, 10)}\n`));
await $`bunx bumpp ${FILES} --release ${target} --all --commit ${"chore: release v%s"} --tag ${"v%s"} --push --yes`;

console.log(`\n✔ Pushed v${target}. Watch the Release workflow: https://github.com/nikuscs/agents-mail/actions`);

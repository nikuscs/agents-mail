#!/usr/bin/env bun

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = dirname(import.meta.dirname);
const agentsRoot = import.meta.dirname;

function removeLink(target: string) {
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    rmSync(target);
  }
}

function link(source: string, target: string) {
  removeLink(target);

  if (!existsSync(source)) {
    return;
  }

  if (lstatSync(target, { throwIfNoEntry: false })) {
    console.log(`Skipped ${relative(root, target)}: a real file or folder is there`);
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(relative(dirname(target), source), target);
}

function linkEach(sourceDir: string, targetDir: string) {
  for (const entry of existsSync(targetDir) ? readdirSync(targetDir) : []) {
    removeLink(join(targetDir, entry));
  }

  if (!existsSync(sourceDir)) {
    return;
  }

  for (const entry of readdirSync(sourceDir)) {
    link(join(sourceDir, entry), join(targetDir, entry));
  }
}

link(join(root, 'AGENTS.md'), join(root, 'CLAUDE.md'));
linkEach(join(agentsRoot, 'skills'), join(root, '.claude/skills'));
linkEach(join(agentsRoot, 'agents'), join(root, '.claude/agents'));

for (const config of ['paseo.json', 'orca.yaml']) {
  link(join(agentsRoot, 'orchestrators', config), join(root, config));
}

console.log('Linked CLAUDE.md, .claude/ and the orchestrator configs');

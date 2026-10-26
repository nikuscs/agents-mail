#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = dirname(import.meta.dirname);
const agentsRoot = import.meta.dirname;

function link(source: string, target: string) {
  rmSync(target, { force: true, recursive: true });
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(relative(dirname(target), source), target);
}

function linkEach(sourceDir: string, targetDir: string) {
  rmSync(targetDir, { force: true, recursive: true });

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

console.log('Linked CLAUDE.md and .claude/');

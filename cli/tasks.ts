// bb tasks import <path> — Markdown task files (one task per file, frontmatter + body) into the backlog.
// A directory imports every *.md in it (recursively) that has frontmatter. Existing ids are updated, never duplicated.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { orderByDeps, parseTaskFile, TaskFileError, taskFileToCreate, type TaskFile } from '../shared/tasks-md.ts';
import { agentClient } from './mcp.ts';
import { readClientConfig } from './config.ts';

function mdFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...mdFiles(p));
    else if (/\.md$/i.test(e.name)) out.push(p);
  }
  return out.sort();
}

export function readTaskFiles(path: string): { tasks: (TaskFile & { ref: string })[]; skipped: string[] } {
  if (!statSync(path).isDirectory()) return { tasks: [{ ...parseTaskFile(readFileSync(path, 'utf8'), basename(path)), ref: basename(path) }], skipped: [] };
  const tasks: (TaskFile & { ref: string })[] = [];
  const skipped: string[] = [];
  for (const f of mdFiles(path)) {
    const text = readFileSync(f, 'utf8');
    if (!/^﻿?---\r?\n/.test(text)) {
      skipped.push(f);
      continue;
    }
    tasks.push({ ...parseTaskFile(text, basename(f)), ref: relative(path, f) });
  }
  return { tasks, skipped };
}

export async function tasksCli(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'import') {
    console.error('usage: bb tasks import <file.md | dir> [--dry-run]');
    return 1;
  }
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { 'dry-run': { type: 'boolean' } } });
  const path = positionals[0];
  if (!path) {
    console.error('usage: bb tasks import <file.md | dir> [--dry-run]');
    return 1;
  }
  let batch: (TaskFile & { ref: string })[];
  try {
    const r = readTaskFiles(path);
    batch = orderByDeps(r.tasks);
    for (const s of r.skipped) console.error(`skipped (no frontmatter): ${s}`);
  } catch (e) {
    if (e instanceof TaskFileError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
  if (values['dry-run']) {
    for (const t of batch) console.log(`${t.id ?? '(new id)'}\t${t.status ?? 'backlog'}\t${t.title}${t.dependsOn.length ? `\tafter ${t.dependsOn.join(', ')}` : ''}`);
    return 0;
  }
  const url = process.env.BUILDYBOY_URL || readClientConfig().url;
  const token = process.env.BUILDYBOY_AGENT_TOKEN;
  if (!url || !token) {
    console.error('set BUILDYBOY_AGENT_TOKEN (Settings → Agent tokens) and BUILDYBOY_URL');
    return 1;
  }
  const client = agentClient(url, token);
  for (const t of batch) {
    const out = (await client.call('tasks_create', taskFileToCreate(t, t.ref))) as { id: string; status: string };
    console.log(`${out.id}\t${out.status}\t${t.title}`);
  }
  return 0;
}

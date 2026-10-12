#!/usr/bin/env node
// Buildyboy statusline bridge (optional, never installed automatically).
// Configure in ~/.claude/settings.json:  "statusLine": { "type": "command", "command": "node <path>/bb-statusline.mjs" }
// It POSTs the statusline JSON to the server (at most once every 10 s per session), then runs your previous statusline
// command from BUILDYBOY_STATUSLINE_NEXT (same stdin) and passes its output through.
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.BUILDYBOY_HOME || join(homedir(), '.buildyboy');
const THROTTLE_MS = 10_000;

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const raw = Buffer.concat(chunks).toString('utf8');
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    // pass through
  }
  await Promise.all([send(data), passThrough(raw, data)]);
  process.exit(0);
});

async function send(data) {
  try {
    if (process.env.BUILDYBOY_DISABLED === '1' || !data.session_id) return;
    let cfg = {};
    try {
      cfg = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'));
    } catch {
      // not paired
    }
    const url = (process.env.BUILDYBOY_URL || cfg.url || '').replace(/\/$/, '');
    const token = process.env.BUILDYBOY_TOKEN || cfg.token;
    if (!url || !token) return;
    const dir = join(HOME, 'statusline');
    mkdirSync(dir, { recursive: true });
    const stamp = join(dir, String(data.session_id).replace(/[^\w.-]/g, '_'));
    try {
      if (Date.now() - statSync(stamp).mtimeMs < THROTTLE_MS) return;
    } catch {
      // first call
    }
    writeFileSync(stamp, '');
    await fetch(`${url}/api/statusline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(800),
    });
  } catch {
    // fail open
  }
}

function passThrough(raw, data) {
  const next = process.env.BUILDYBOY_STATUSLINE_NEXT;
  if (!next) {
    const parts = [data.model?.display_name, data.context_window?.used_percentage != null ? `ctx ${Math.round(data.context_window.used_percentage)}%` : null, data.cost?.total_cost_usd != null ? `$${data.cost.total_cost_usd.toFixed(2)}` : null];
    process.stdout.write(parts.filter(Boolean).join(' · '));
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const p = spawn(next, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    p.on('close', resolve);
    p.on('error', resolve);
    p.stdin.end(raw);
  });
}

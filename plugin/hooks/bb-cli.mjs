#!/usr/bin/env node
// Backs the plugin's slash commands. Zero dependencies.
//   node bb-cli.mjs status          server reachability, machine id, walk mode, spool size
//   node bb-cli.mjs walk [on|off|5m] walk mode for this session (5m = on, and Stop holds 5 minutes for my reply)
//   node bb-cli.mjs link            this session's Buildyboy URL
import { readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.BUILDYBOY_HOME || join(homedir(), '.buildyboy');
const [cmd = 'status', arg = 'on'] = process.argv.slice(2);
const sid = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';

let cfg = {};
try {
  cfg = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'));
} catch {
  // not paired
}
const url = (process.env.BUILDYBOY_URL || cfg.url || '').replace(/\/$/, '');
const token = process.env.BUILDYBOY_TOKEN || cfg.token;

async function api(method, path, body) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`server answered ${res.status}`);
  return res.json();
}

function spool() {
  try {
    return statSync(join(HOME, 'spool.jsonl')).size;
  } catch {
    return 0;
  }
}

async function main() {
  if (!url || !token) {
    console.log(`Buildyboy is not configured on this machine (no ${join(HOME, 'config.json')}). Pair it from the Machines page.`);
    return;
  }
  if (cmd === 'status') {
    try {
      const s = await api('GET', `/api/machine/status${sid ? `?session=${encodeURIComponent(sid)}` : ''}`);
      console.log(`Server: ${url} (reachable)`);
      console.log(`Machine: ${s.name} (${s.machineId})`);
      console.log(`Walk mode: ${s.session ? `${s.session.walk ? 'ON' : 'off'} for this session` : `${s.machineWalk ? 'ON' : 'off'} for this machine`}`);
      console.log(`Spool: ${spool()} bytes waiting locally`);
      if (s.session) console.log(`Session: ${s.session.url}`);
    } catch (e) {
      console.log(`Server: ${url} is NOT reachable (${e.message}). Hooks fail open; events spool locally (${spool()} bytes).`);
    }
  } else if (cmd === 'walk') {
    const m = /^(\d+(?:\.\d+)?)m$/.exec(arg);
    const on = arg !== 'off';
    const r = await api('POST', '/api/machine/walk', { sessionId: sid || undefined, on, stopWaitMin: m ? Number(m[1]) : undefined });
    // refresh the local control cache right away so the next PreToolUse sees it
    try {
      const tmp = join(HOME, `control.json.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(r.control));
      renameSync(tmp, join(HOME, 'control.json'));
    } catch {
      // ignore
    }
    console.log(`Walk mode ${on ? 'ON' : 'off'} for this ${r.scope}${m ? `; at the end of a turn Claude waits up to ${m[1]} min for your reply` : ''}.`);
  } else if (cmd === 'link') {
    console.log(sid ? `${url}/s/${sid}` : `${url}/ (session id not available in this shell)`);
  } else {
    console.log('usage: bb-cli.mjs status | walk [on|off|5m] | link');
  }
}

main().catch((e) => console.log(`Buildyboy: ${e.message}`));

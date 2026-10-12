#!/usr/bin/env node
// Buildyboy hook: forwards Claude Code hook events to the Buildyboy server.
// Zero dependencies, Node built-ins only, runs on Windows and Linux.
//
//   node bb-hook.mjs                 telemetry (async hooks): POST /api/ingest, spool on failure
//   node bb-hook.mjs --sync          telemetry that must finish before Claude exits (SessionEnd)
//   node bb-hook.mjs --control [--wait <s>]   control events: POST /api/hook/<event>, print the decision
//   node bb-hook.mjs --control --lean         PreToolUse fast path: only calls the server when the cache says so
//
// Fail open, always: if anything goes wrong, print nothing and exit 0.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, renameSync, openSync, readSync, closeSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir, hostname, userInfo, arch } from 'node:os';
import { join } from 'node:path';

const HOOK_VERSION = '0.1.0';
const TRANSCRIPT_CAP = 256 * 1024;
const PROGRESS_CAP = 32 * 1024;
const SPOOL_CAP = 50 * 1024 * 1024;
const BATCH_CAP = 2 * 1024 * 1024;
const BREAKER_MS = 60_000;
const CONNECT_MS = 1000;
const ENV_ALLOW = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR', 'TERM_PROGRAM', 'BUILDYBOY_JOB_ID', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_REMOTE'];
const TRANSCRIPT_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd', 'UserPromptSubmit']);
const GIT_EVENTS = new Set(['SessionStart', 'Stop', 'SessionEnd']);

const args = process.argv.slice(2);
const CONTROL = args.includes('--control');
const LEAN = args.includes('--lean');
const SYNC = args.includes('--sync');
const waitIdx = args.indexOf('--wait');
const WAIT_MS = waitIdx >= 0 ? Number(args[waitIdx + 1]) * 1000 : 590_000;

const HOME = process.env.BUILDYBOY_HOME || join(homedir(), '.buildyboy');
const P = {
  config: join(HOME, 'config.json'),
  control: join(HOME, 'control.json'),
  breaker: join(HOME, 'breaker'),
  spool: join(HOME, 'spool.jsonl'),
  offsets: join(HOME, 'offsets'),
};

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  } catch {
    // ignore
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    const t = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 3000);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(t);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      resolve('');
    });
  });
}

function platform() {
  if (process.platform === 'linux') {
    try {
      if (/microsoft/i.test(readFileSync('/proc/version', 'utf8'))) return 'wsl';
    } catch {
      // ignore
    }
  }
  return process.platform;
}

function breakerOpen() {
  try {
    return Date.now() - statSync(P.breaker).mtimeMs < BREAKER_MS;
  } catch {
    return false;
  }
}

function tripBreaker() {
  try {
    writeFileSync(P.breaker, String(Date.now()));
  } catch {
    // ignore
  }
}

function resetBreaker() {
  try {
    if (existsSync(P.breaker)) unlinkSync(P.breaker);
  } catch {
    // ignore
  }
}

function git(cwd, gitArgs) {
  return new Promise((resolve) => {
    try {
      execFile('git', gitArgs, { cwd, timeout: 1500, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
    } catch {
      resolve(null);
    }
  });
}

function stripCreds(url) {
  return url ? url.replace(/\/\/[^@/]+@/, '//') : url;
}

async function gitInfo(e, state) {
  const cwd = e.cwd || process.cwd();
  const name = e.hook_event_name;
  const command = e.tool_input && typeof e.tool_input.command === 'string' ? e.tool_input.command : '';
  // git calls run in parallel; `status --porcelain=v2 --branch` gives branch, sha, ahead/behind and dirty in one go.
  // Repo root, worktree and remote don't change during a session, so they're cached in the session state.
  const info = {};
  const jobs = [];
  const status = git(cwd, ['status', '--porcelain=v2', '--branch']).then((r) => {
    if (r === null) return false;
    let dirty = 0;
    for (const l of r.split(/\r?\n/)) {
      if (l.startsWith('# branch.oid ')) info.sha = l.slice(13) === '(initial)' ? undefined : l.slice(13);
      else if (l.startsWith('# branch.head ')) info.branch = l.slice(14);
      else if (l.startsWith('# branch.ab ')) {
        const [a, b] = l.slice(12).split(' ');
        info.ahead = Math.abs(Number(a));
        info.behind = Math.abs(Number(b));
      } else if (l && !l.startsWith('#')) dirty++;
    }
    info.dirty = dirty;
    return true;
  });
  if (!state.git) {
    jobs.push(
      Promise.all([
        git(cwd, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir']),
        git(cwd, ['remote', 'get-url', 'origin']),
      ]).then(([head, remote]) => {
        if (!head) return;
        const [root, gitDir, commonDir] = head.split(/\r?\n/);
        state.git = { root, worktree: !!gitDir && !!commonDir && gitDir !== commonDir && !gitDir.endsWith(commonDir), remote: remote ? stripCreds(remote) : undefined };
      }),
    );
  }
  if (name === 'Stop' && state.startSha) {
    jobs.push(git(cwd, ['diff', '--shortstat', state.startSha]).then((r) => {
      if (r !== null) info.shortstat = r;
    }));
  }
  if (name === 'PostToolUse' && /\bgit\b[^|;&]*\bcommit\b/.test(command)) {
    jobs.push(git(cwd, ['log', '-1', '--format=%H%x00%s%x00%an%x00%ct', '--shortstat']).then((r) => {
      if (!r) return;
      const [first, ...rest] = r.split(/\r?\n/);
      const [csha, message, author, ct] = first.split('\0');
      const stat = rest.join(' ');
      const num = (re) => Number((re.exec(stat) || [0, 0])[1]);
      info.lastCommit = { sha: csha, message, author, ts: Number(ct) * 1000, files: num(/(\d+) files? changed/), added: num(/(\d+) insertions?/), removed: num(/(\d+) deletions?/) };
    }));
  }
  if (name === 'PostToolUse' && /\bgh\s+pr\s+create\b/.test(command)) {
    const out = JSON.stringify(e.tool_response ?? '');
    const m = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.exec(out);
    if (m) info.prUrl = m[0];
  }
  const [isRepo] = await Promise.all([status, ...jobs]);
  return isRepo ? { ...state.git, ...info } : undefined;
}

/** Reads new complete JSONL lines from `path` starting at the stored offset (capped). */
function transcriptDelta(path, state, agentId) {
  if (!path) return null;
  let fd;
  try {
    const size = statSync(path).size;
    const offsets = (state.offsets ||= {});
    let start = offsets[path] ?? 0;
    if (start > size) start = 0; // file was replaced
    if (start === size) return null;
    fd = openSync(path, 'r');
    const len = Math.min(TRANSCRIPT_CAP, size - start);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    let end = buf.lastIndexOf(0x0a);
    const lines = [];
    if (end < 0) {
      if (len < TRANSCRIPT_CAP) return null; // partial line still being written
      // a single line longer than the cap: skip it and leave a marker
      let pos = start + len;
      const probe = Buffer.alloc(64 * 1024);
      for (;;) {
        const n = readSync(fd, probe, 0, probe.length, pos);
        if (n <= 0) return null;
        const i = probe.subarray(0, n).indexOf(0x0a);
        if (i >= 0) {
          pos += i + 1;
          break;
        }
        pos += n;
      }
      lines.push(JSON.stringify({ type: 'bb-oversize', bytes: pos - start }));
      offsets[path] = pos;
      return { path, agentId, offset: start, lines };
    }
    const text = buf.subarray(0, end + 1).toString('utf8');
    for (const l of text.split(/\r?\n/)) if (l.trim()) lines.push(l);
    offsets[path] = start + end + 1;
    return { path, agentId, offset: start, lines };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function progressDoc(cwd, state) {
  try {
    const path = join(cwd, 'PROGRESS.md');
    if (!existsSync(path)) return undefined;
    const content = readFileSync(path, 'utf8').slice(0, PROGRESS_CAP);
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    if (hash === state.progressHash) return undefined;
    state.progressHash = hash;
    return { hash, content };
  } catch {
    return undefined;
  }
}

function spoolSize() {
  try {
    return statSync(P.spool).size;
  } catch {
    return 0;
  }
}

function spoolAppend(envelopes) {
  try {
    appendFileSync(P.spool, envelopes.map((x) => JSON.stringify(x)).join('\n') + '\n');
    if (spoolSize() > SPOOL_CAP) {
      // drop the oldest entries
      const lines = readFileSync(P.spool, 'utf8').split('\n').filter(Boolean);
      let total = 0;
      const keep = [];
      for (let i = lines.length - 1; i >= 0; i--) {
        total += lines[i].length + 1;
        if (total > SPOOL_CAP * 0.8) break;
        keep.unshift(lines[i]);
      }
      writeFileSync(P.spool, keep.join('\n') + '\n');
    }
  } catch {
    // ignore
  }
}

/** Claims the spool for sending by renaming it, so concurrent hooks don't send it twice. */
/** A hook killed mid-send leaves its claimed spool behind; after a minute, put those events back. */
function recoverStaleClaims() {
  try {
    for (const f of readdirSync(HOME)) {
      if (!/^spool\.jsonl\.\d+\.sending$/.test(f)) continue;
      const path = join(HOME, f);
      if (Date.now() - statSync(path).mtimeMs < 60_000) continue;
      appendFileSync(P.spool, readFileSync(path, 'utf8'));
      unlinkSync(path);
    }
  } catch {
    // ignore
  }
}

function spoolClaim() {
  recoverStaleClaims();
  if (!spoolSize()) return null;
  const claimed = `${P.spool}.${process.pid}.sending`;
  try {
    renameSync(P.spool, claimed);
    const lines = readFileSync(claimed, 'utf8').split('\n').filter(Boolean);
    const items = [];
    for (const l of lines) {
      try {
        items.push(JSON.parse(l));
      } catch {
        // drop corrupt lines
      }
    }
    return { claimed, items };
  } catch {
    return null;
  }
}

/**
 * POSTs JSON. Errors carry `kind`: 'network' (unreachable, 5xx, garbage: retry later), 'rejected' (4xx: the server
 * will never take it, so don't retry) or 'late' (the server answered but the long-poll outlived our wait).
 */
async function post(url, token, body, headersMs, totalMs) {
  const fail = (e, kind) => Object.assign(e instanceof Error ? e : new Error(String(e)), { kind });
  const ac = new AbortController();
  const t1 = setTimeout(() => ac.abort(), headersMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    throw fail(e, 'network');
  } finally {
    clearTimeout(t1);
  }
  const t2 = setTimeout(() => ac.abort(), totalMs);
  let text;
  try {
    text = await res.text();
  } catch (e) {
    throw fail(e, res.ok ? 'late' : 'network');
  } finally {
    clearTimeout(t2);
  }
  if (!res.ok) throw fail(new Error(`http ${res.status}`), res.status >= 500 ? 'network' : 'rejected');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw fail(e, 'network');
  }
}

function needsServer(e, cache) {
  if (!cache) return false;
  if (cache.pauseAll) return true;
  const s = cache.sessions && cache.sessions[e.session_id];
  const walk = s ? s.walk : cache.walk;
  if (s && (s.kill || s.pause || s.queued)) return true;
  return !!walk && e.tool_name === 'AskUserQuestion';
}

let output = '';

async function main() {
  if (process.env.BUILDYBOY_DISABLED === '1') return;
  const raw = await readStdin();
  let e;
  try {
    e = JSON.parse(raw);
  } catch {
    return;
  }
  if (!e || typeof e.session_id !== 'string' || typeof e.hook_event_name !== 'string') return;

  const cfg = readJson(P.config, {}) || {};
  const url = (process.env.BUILDYBOY_URL || cfg.url || '').replace(/\/$/, '');
  const token = process.env.BUILDYBOY_TOKEN || cfg.token;
  if (!url || !token) return;
  const name = e.hook_event_name;

  if (CONTROL && LEAN && !needsServer(e, readJson(P.control))) return;
  if (breakerOpen() && CONTROL && LEAN) return;

  try {
    mkdirSync(P.offsets, { recursive: true });
  } catch {
    // ignore
  }
  const statePath = join(P.offsets, `${String(e.session_id).replace(/[^\w.-]/g, '_')}.json`);
  const state = readJson(statePath, {}) || {};

  const env = {};
  for (const k of ENV_ALLOW) if (process.env[k]) env[k] = process.env[k];
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    // ignore
  }
  const envelope = {
    v: 1,
    machineId: cfg.machineId,
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    user,
    pid: process.pid,
    ppid: process.ppid,
    hookVersion: HOOK_VERSION,
    ts: Date.now(),
    env,
    event: e,
  };

  if (LEAN) {
    envelope.controlOnly = true;
  } else {
    const isGitBash = name === 'PostToolUse' && e.tool_name === 'Bash' && /\b(git|gh)\b/.test(String(e.tool_input?.command ?? ''));
    if (GIT_EVENTS.has(name) || isGitBash) {
      const g = await gitInfo(e, state);
      if (g) {
        envelope.git = g;
        if (name === 'SessionStart' && !state.startSha && g.sha) state.startSha = g.sha;
        if (!state.startSha && g.sha) state.startSha = g.sha;
      }
    }
    if (TRANSCRIPT_EVENTS.has(name)) {
      const deltas = [];
      const main = transcriptDelta(e.transcript_path, state);
      if (main) deltas.push(main);
      if (e.agent_transcript_path) {
        const sub = transcriptDelta(e.agent_transcript_path, state, e.agent_id);
        if (sub) deltas.push(sub);
      }
      if (deltas.length) envelope.transcripts = deltas;
    }
    if (name === 'Stop' && e.cwd) {
      const p = progressDoc(e.cwd, state);
      if (p) envelope.progress = p;
    }
    envelope.spoolBytes = spoolSize();
  }
  // offsets/hashes advance now: the data is either sent or spooled
  if (!LEAN) writeJsonAtomic(statePath, state);

  if (CONTROL) {
    if (breakerOpen()) {
      // server recently unreachable: don't wait on it, but keep the event for later
      spoolAppend([envelope]);
      return;
    }
    try {
      const res = await post(`${url}/api/hook/${encodeURIComponent(name)}`, token, envelope, CONNECT_MS, WAIT_MS);
      resetBreaker();
      if (res && res.control) writeJsonAtomic(P.control, res.control);
      if (res && res.output) output = JSON.stringify(res.output);
    } catch (err) {
      if (err.kind === 'network') {
        tripBreaker();
        if (!LEAN) spoolAppend([envelope]);
      }
    }
    return;
  }

  // telemetry
  if (breakerOpen()) {
    spoolAppend([envelope]);
    return;
  }
  // SessionEnd (--sync) has a short budget: send just this event; the next session flushes the spool
  const spooled = SYNC ? null : spoolClaim();
  const batch = [];
  let bytes = 0;
  const rest = [];
  for (const item of spooled?.items ?? []) {
    const n = JSON.stringify(item).length;
    if (bytes + n > BATCH_CAP) rest.push(item);
    else {
      batch.push(item);
      bytes += n;
    }
  }
  batch.push(envelope);
  try {
    const res = await post(`${url}/api/ingest`, token, { envelopes: batch }, SYNC ? CONNECT_MS : CONNECT_MS * 3, SYNC ? 2500 : 10_000);
    resetBreaker();
    if (res && res.control) writeJsonAtomic(P.control, res.control);
    if (rest.length) spoolAppend(rest);
  } catch (err) {
    if (err.kind === 'rejected') {
      if (rest.length) spoolAppend(rest); // the server refused this batch; retrying it would block the spool forever
    } else {
      tripBreaker();
      spoolAppend([...batch, ...rest]);
    }
  } finally {
    if (spooled) {
      try {
        unlinkSync(spooled.claimed);
      } catch {
        // ignore
      }
    }
  }
}

main()
  .catch(() => {})
  .finally(() => {
    // pipes are async on POSIX: exit only once stdout has flushed
    if (output) process.stdout.write(output, () => process.exit(0));
    else process.exit(0);
  });

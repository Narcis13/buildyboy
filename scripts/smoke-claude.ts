// Real Claude Code smoke test (M4). Runs `claude -p --plugin-dir ./plugin` against a temp server + DB in temp git repos:
//   1. telemetry: a small read/write/commit task → session, hook events, parsed messages and a git snapshot with the commit
//   2. remote approval: default permission mode + walk mode; the test approves the Write through the API → file exists
// Uses the cheapest model alias and a small budget per run. Never touches ~/.claude settings or ~/.buildyboy.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../server/main.ts';
import { createMachine } from '../server/auth.ts';

const ROOT = resolve(import.meta.dirname, '..');
const MODEL = process.env.SMOKE_MODEL ?? 'haiku';
const BUDGET = process.env.SMOKE_BUDGET ?? '0.30';
const CLAUDE = process.env.BUILDYBOY_CLAUDE_BIN ?? 'claude';

let failures = 0;
let totalCost = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✔' : '✘'} ${msg}`);
  if (!ok) failures++;
};

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-smoke-repo-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'smoke@example.com');
  git('config', 'user.name', 'Smoke Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# Smoke test repo\n\nA tiny synthetic project.\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}

/** Child env: the machine's normal env minus anything inherited from a parent Claude Code session. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|CLAUDECODE|MCP_|OTEL_|BUILDYBOY_)/.test(k) || k === 'ANTHROPIC_BASE_URL') continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function runClaude(cwd: string, prompt: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: any; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(CLAUDE, ['-p', prompt, '--plugin-dir', join(ROOT, 'plugin'), '--model', MODEL, '--max-budget-usd', BUDGET, '--setting-sources', 'project,local', '--output-format', 'json', ...args], {
      cwd,
      env: cleanEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill(), 240_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      let json: any = null;
      try {
        json = JSON.parse(out);
      } catch {
        json = { raw: out.slice(0, 2000) };
      }
      if (typeof json?.total_cost_usd === 'number') totalCost += json.total_cost_usd;
      res({ code, out: json, stderr: err });
    });
  });
}

async function poll<T>(fn: () => T | undefined | null | false, ms = 15_000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return undefined;
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'bb-smoke-data-'));
  const home = mkdtempSync(join(tmpdir(), 'bb-smoke-home-'));
  const srv = await startServer({ port: 0, dataDir, stopWaitMin: 0, permissionWaitMs: 120_000 }, { quiet: true, background: false });
  const { db } = srv.ctx;
  const machine = createMachine(srv.ctx, 'smoke-machine');
  const env = { BUILDYBOY_URL: srv.url, BUILDYBOY_TOKEN: machine.token, BUILDYBOY_HOME: home };
  console.log(`server ${srv.url}, data ${dataDir}, model ${MODEL}, budget $${BUDGET}/run`);

  try {
    // ---- run 1: telemetry path ----
    const repo1 = tempRepo();
    const startSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo1 }).toString().trim();
    const r1 = await runClaude(
      repo1,
      "Read README.md. Then create a file notes.txt containing exactly the line: hello from smoke. Then run this single Bash command: git add notes.txt && git commit -m 'add notes'. Finally reply with the single word done.",
      ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Write', 'Bash(git add:*)', 'Bash(git commit:*)'],
      env,
    );
    const sid1: string | undefined = r1.out?.session_id;
    console.log(`run 1: exit ${r1.code}, session ${sid1}, cost $${r1.out?.total_cost_usd}, result: ${String(r1.out?.result ?? '').slice(0, 120)}`);
    if (r1.code !== 0) console.log(r1.stderr.slice(0, 2000));
    check(!!sid1, 'run 1 returned a session id');
    if (sid1) {
      const sess = await poll(() => db.get<{ id: string; source: string; status: string }>('SELECT id, source, status FROM sessions WHERE id = ?', sid1));
      check(!!sess, `session row exists (source=${sess?.source}, status=${sess?.status})`);
      const names = await poll(() => {
        const e = db.all<{ event: string }>('SELECT DISTINCT event FROM events WHERE session_id = ?', sid1).map((x) => x.event);
        return ['SessionStart', 'PostToolUse', 'Stop'].every((n) => e.includes(n)) ? e : false;
      });
      check(!!names, `SessionStart, PostToolUse and Stop arrived (${(names ?? db.all<{ event: string }>('SELECT DISTINCT event FROM events WHERE session_id = ?', sid1).map((x) => x.event)).join(', ')})`);
      const msgs = await poll(() => {
        const n = db.get<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE session_id = ? AND role = 'assistant'", sid1)!.n;
        return n > 0 ? n : false;
      });
      check(!!msgs, `assistant messages parsed from the transcript (${msgs ?? 0})`);
      const tools = db.all<{ tool_name: string; status: string }>('SELECT tool_name, status FROM tool_calls WHERE session_id = ?', sid1);
      console.log(`  tool calls: ${tools.map((t) => `${t.tool_name}:${t.status}`).join(', ')}`);
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo1 }).toString().trim();
      check(headSha !== startSha, 'the commit happened in the temp repo');
      const snap = await poll(() => db.get<{ sha: string }>('SELECT sha FROM git_snapshots WHERE session_id = ? AND sha = ?', sid1, headSha));
      const commit = db.get<{ message: string }>('SELECT message FROM commits WHERE session_id = ?', sid1);
      check(!!snap, `a git snapshot shows the new commit ${headSha.slice(0, 8)}${commit ? ` ("${commit.message}")` : ''}`);
    }

    // ---- run 2: remote approval path ----
    db.setSetting('walk_mode', true);
    const repo2 = tempRepo();
    let answered = null as string | null;
    let stopPolling = false;
    const approver = (async () => {
      while (!stopPolling) {
        const p = db.get<{ id: string; tool_name: string }>("SELECT id, tool_name FROM pending_actions WHERE status = 'pending' AND kind = 'permission' ORDER BY created_at LIMIT 1");
        if (p) {
          // answer exactly like the Inbox does
          const web = await login(srv.url);
          const res = await fetch(`${srv.url}/api/actions/${p.id}/answer`, { method: 'POST', headers: web, body: JSON.stringify({ type: 'allow' }) });
          answered = `${p.tool_name} -> ${res.status}`;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    })();
    const r2 = await runClaude(repo2, 'Create a file approved.txt containing exactly the word yes. Then reply with the single word done.', ['--permission-mode', 'default'], env);
    stopPolling = true;
    await approver;
    console.log(`run 2: exit ${r2.code}, session ${r2.out?.session_id}, cost $${r2.out?.total_cost_usd}, answered: ${answered}`);
    if (r2.code !== 0) console.log(r2.stderr.slice(0, 2000));
    check(!!answered && answered.startsWith('Write'), 'a Write permission request reached the Inbox and was approved through the API');
    check(existsSync(join(repo2, 'approved.txt')) && readFileSync(join(repo2, 'approved.txt'), 'utf8').includes('yes'), 'approved.txt exists after the remote approval');
    const decision = db.get<{ summary: string }>("SELECT summary FROM events WHERE session_id = ? AND event = 'Decision'", r2.out?.session_id ?? '');
    check(!!decision, `the decision is on the timeline (${decision?.summary})`);
  } finally {
    console.log(`total cost: $${totalCost.toFixed(4)}`);
    await srv.close();
  }
  if (failures) {
    console.error(`smoke:claude FAILED (${failures} checks)`);
    process.exit(1);
  }
  console.log('smoke:claude passed');
}

const SMOKE_PASSWORD = 'smoke-test-password';
let cachedHeaders: Record<string, string> | null = null;

/** Logs in like the web UI does; returns headers with the session cookie and CSRF token. */
async function login(url: string): Promise<Record<string, string>> {
  if (cachedHeaders) return cachedHeaders;
  const res = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: SMOKE_PASSWORD }) });
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  const csrf = cookies.find((c) => c.startsWith('bb_csrf='))?.slice(8) ?? '';
  cachedHeaders = { cookie: cookies.join('; '), 'x-bb-csrf': csrf, 'content-type': 'application/json' };
  return cachedHeaders;
}

process.env.BUILDYBOY_INITIAL_PASSWORD = SMOKE_PASSWORD;
await main();

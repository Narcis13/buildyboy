// npm run smoke:mcp — end to end: a server on a temporary DB, `bb mcp` spawned over stdio with an agent token,
// and one successful call of every MCP tool. Usage data arrives the real way (hook SessionStart + statusline POST).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startServer } from '../server/main.ts';
import { createMachine } from '../server/auth.ts';
import { createAgentToken, revokeAgentToken } from '../server/factory/agent.ts';
import { answerDecision } from '../server/factory/decisions.ts';
import { requestControl } from '../server/factory/tasks.ts';
import { TOOL_NAMES, type ToolName } from '../shared/factory.ts';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
// 1×1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

export async function smokeMcp(log = (s: string) => console.log(s)): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bb-smoke-mcp-'));
  const home = join(dir, 'home');
  const srv = await startServer({ port: 0, dataDir: join(dir, 'data') }, { quiet: true, background: false });
  let client: Client | null = null;
  try {
    const machine = createMachine(srv.ctx, 'smoke');
    const post = (path: string, body: unknown) =>
      fetch(`${srv.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${machine.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sid = 'smoke-mcp-session';
    assert((await post('/api/ingest', { v: 1, ts: Date.now(), env: {}, hostname: 'h', platform: process.platform, user: 'u', pid: 1, ppid: 1, hookVersion: 'smoke', event: { session_id: sid, cwd: dir, hook_event_name: 'SessionStart' } })).ok, 'ingest');
    const resets = Math.floor(Date.now() / 1000) + 3600;
    assert((await post('/api/statusline', { session_id: sid, rate_limits: { five_hour: { used_percentage: 12, resets_at: resets }, seven_day: { used_percentage: 30, resets_at: resets + 86400 } } })).ok, 'statusline');

    const agent = createAgentToken(srv.ctx, 'smoke-coordinator');
    const shot = join(dir, 'g4-desktop.png');
    writeFileSync(shot, PNG);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'cli', 'bb.ts'), 'mcp'],
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', BUILDYBOY_URL: srv.url, BUILDYBOY_AGENT_TOKEN: agent.token, BUILDYBOY_HOME: home },
      stderr: 'pipe',
    });
    client = new Client({ name: 'bb-smoke', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const listed = new Set(tools.map((t) => t.name));
    for (const n of TOOL_NAMES) assert(listed.has(n), `tool ${n} is listed`);
    log(`✔ connected over stdio; ${tools.length} tools listed`);

    const called = new Set<ToolName>();
    const call = async <T = any>(name: ToolName, args: Record<string, unknown> = {}): Promise<T> => {
      const r = (await client!.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
      const text = r.content.map((c) => c.text).join('\n');
      if (r.isError) throw new Error(`${name}: ${text}`);
      called.add(name);
      return JSON.parse(text) as T;
    };

    const usage = await call('usage_get');
    assert(usage.fiveHour?.pct === 12 && usage.sevenDay?.resetsAt === (resets + 86400) * 1000, 'usage_get windows');
    const gov = await call('governor_get');
    assert(gov.canStart === true && gov.stopAll === false, `governor_get canStart (${gov.reason})`);
    const sessions = await call<any[]>('sessions_list', { live: true });
    assert(sessions.some((s) => s.id === sid), 'sessions_list has the session');
    assert((await call('sessions_get', { id: sid })).id === sid, 'sessions_get');

    await call('tasks_create', { id: 'P1', title: 'Fundația', status: 'gata', acceptance: ['pnpm verify passes'], repo: 'arond' });
    await call('tasks_create', { id: 'P2', title: 'Gestiune', status: 'gata', dependsOn: ['P1'], sensitive: true });
    const ready = await call<any[]>('tasks_list', { ready: true });
    assert(ready.length === 1 && ready[0].id === 'P1', 'tasks_list ready = [P1] (P2 waits on P1)');
    const claim = await call('tasks_claim', { agent: 'coordinator' });
    assert(claim.task?.id === 'P1' && claim.task.status === 'in_lucru', 'tasks_claim P1');

    const rendered = await call('prompts_render', { slots: { Goal: 'Build P1', 'Done when': '`pnpm verify` passes' } });
    assert(typeof rendered.rendered === 'string' && rendered.rendered.includes('Build P1'), 'prompts_render');
    const lint = await call('prompts_lint', { slots: { Goal: 'Build P1' } });
    assert(Array.isArray(lint.warnings), 'prompts_lint');
    const saved = await call('prompts_save', { title: 'P1 worker', slots: { Goal: 'Build P1' }, taskId: 'P1' });
    assert(saved.id > 0 && saved.version === 1, 'prompts_save');

    const upd = await call('tasks_update', { id: 'P1', status: 'la_porti', branch: 'pachet/P1', costUsd: 1.25, note: 'worker done' });
    assert(upd.status === 'la_porti' && upd.branch === 'pachet/P1' && upd.promptId === saved.id, 'tasks_update');
    const gate = await call('gates_record', { taskId: 'P1', gate: 'G4', verdict: 'pass', summary: 'Desktop and phone look right', screenshots: [{ name: 'desktop', path: shot }] });
    assert(gate.shots.length === 1, 'gates_record stored the screenshot');
    const shotRes = await fetch(`${srv.url}${gate.shots[0].url}`);
    assert(shotRes.status === 401, 'screenshots need a web login');

    const asked = await call('decision_ask', { question: 'Q8: which AI layer scope?', options: ['minimal', 'full'], taskId: 'P2' });
    assert((await call('decision_get', { id: asked.id })).status === 'pending', 'decision_get pending');
    answerDecision(srv.ctx, asked.id, 'minimal', 'web');
    const answered = await call('decision_get', { id: asked.id });
    assert(answered.status === 'answered' && answered.answer === 'minimal', 'decision_get answered');

    requestControl(srv.ctx, 'P1', 'stop', 'pause this one', 'web');
    const ctl = await call('control_get', { ack: true });
    assert(ctl.requests.length === 1 && ctl.requests[0].kind === 'stop', 'control_get');
    assert((await call('control_get')).requests.length === 0, 'control_get after ack');

    await call('tasks_update', { id: 'P1', status: 'integrata' });
    assert((await call<any[]>('tasks_list', { ready: true })).some((t) => t.id === 'P2'), 'P2 ready once P1 is integrated');
    assert((await call('tasks_get', { id: 'P1' })).gateResults.length === 1, 'tasks_get');
    const digest = await call('digest_post', { note: 'smoke' });
    assert(/P1/.test(digest.body), 'digest_post mentions P1');

    for (const n of TOOL_NAMES) assert(called.has(n), `tool ${n} was called`);
    log(`✔ all ${called.size} tools answered: ${[...called].join(', ')}`);

    revokeAgentToken(srv.ctx, agent.id);
    const denied = (await client.callTool({ name: 'usage_get', arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    assert(denied.isError && /unauthorized/.test(denied.content[0].text), 'revoked token is refused');
    log('✔ a revoked agent token is refused');
  } finally {
    await client?.close().catch(() => {});
    await srv.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may hold the WAL briefly
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokeMcp().then(
    () => console.log('smoke:mcp passed'),
    (e) => {
      console.error(`smoke:mcp FAILED: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}

// Operators (SPEC §12.7): token scopes, the operator tools (factory_status, decisions, controls, projects, the Inbox),
// the rules (scopes, never one's own question, never a launch approval), the audit and the digest line.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer, type WebClient } from './helpers.ts';
import { createMachine } from '../server/auth.ts';
import { createAgentToken } from '../server/factory/agent.ts';
import { digestData, digestText } from '../server/factory/digest.ts';
import type { FactoryStatus } from '../shared/factory.ts';

let srv: TestServer;
let web: WebClient;
let machine: { id: string; token: string };
const tok: Record<string, { id: string; token: string }> = {};

interface Answer {
  status: number;
  result?: any;
  error?: string;
  replayed?: boolean;
}
const raw = async (who: string, tool: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<Answer> => {
  const r = await fetch(`${srv.url}/api/agent/${tool}`, {
    method: 'POST', headers: { authorization: `Bearer ${tok[who].token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: r.status, ...((await r.json()) as object) };
};
const call = async (who: string, tool: string, body: unknown = {}) => {
  const a = await raw(who, tool, body);
  if (a.status !== 200) throw new Error(`${tool} ${a.status} ${a.error}`);
  return a.result;
};
const machinePost = (path: string, body: unknown) =>
  fetch(`${srv.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${machine.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const envelope = (event: Record<string, unknown>) => ({ v: 1, ts: Date.now(), env: {}, hostname: 'h', platform: process.platform, user: 'u', pid: 1, ppid: 1, hookVersion: 'test', event });
const audit = (action: string, target: string) => srv.ctx.db.all<{ actor: string }>('SELECT actor FROM audit_log WHERE action = ? AND target = ? ORDER BY id', action, target);

beforeAll(async () => {
  srv = await startTestServer({ permissionWaitMs: 20_000 });
  srv.ctx.notify = () => {};
  web = await srv.login();
  machine = createMachine(srv.ctx, 'box');
  for (const name of ['coordinator', 'deputy', 'deputy2', 'inbox', 'launcher']) tok[name] = createAgentToken(srv.ctx, name === 'deputy2' ? 'deputy' : name);
  // usage data, so the governor lets launches through
  const sid = 'operator-usage';
  await machinePost('/api/ingest', envelope({ session_id: sid, cwd: srv.dataDir, hook_event_name: 'SessionStart' }));
  const resets = Math.floor(Date.now() / 1000) + 3600;
  await machinePost('/api/statusline', { session_id: sid, rate_limits: { five_hour: { used_percentage: 10, resets_at: resets }, seven_day: { used_percentage: 20, resets_at: resets + 86400 } } });
});
afterAll(() => srv.stop());

describe('token scopes', () => {
  it('are off by default, set from the web only, and audited', async () => {
    const list = await web.get('/api/agent-tokens');
    expect(list.find((t: any) => t.id === tok.deputy.id)).toMatchObject({ operator: false, inbox: false, launch: 'off' });
    expect(await web.put(`/api/agent-tokens/${tok.deputy.id}`, { operator: true })).toMatchObject({ operator: true, inbox: false });
    await web.put(`/api/agent-tokens/${tok.deputy2.id}`, { operator: true });
    expect(await web.put(`/api/agent-tokens/${tok.inbox.id}`, { inbox: true })).toMatchObject({ operator: false, inbox: true });
    await web.put(`/api/agent-tokens/${tok.launcher.id}`, { launch: 'workers' });
    expect(audit('agent_token_scopes', tok.deputy.id).map((a) => a.actor)).toEqual(['web']);
    await expect(web.put(`/api/agent-tokens/${tok.deputy.id}`, { operator: 'yes' })).rejects.toThrow(/400/);
    // an agent token cannot reach the web route
    const r = await fetch(`${srv.url}/api/agent-tokens/${tok.coordinator.id}`, { method: 'PUT', headers: { authorization: `Bearer ${tok.deputy.token}`, 'content-type': 'application/json' }, body: '{"operator":true}' });
    expect(r.status).toBe(401);
  });
});

describe('the rules', () => {
  let taskDecision: string;
  beforeAll(async () => {
    await web.post('/api/factory/projects', { key: 'rules', name: 'Rules', repo: 'acme/rules' });
    await web.post('/api/tasks', { project: 'rules', id: 'R1', title: 'First', status: 'in_lucru' });
    taskDecision = (await call('coordinator', 'decision_ask', { question: 'Red or blue?', options: ['Red', 'Blue'], taskId: 'R1' })).id;
  });

  it('every write answers 403 naming the switch when the token lacks the scope', async () => {
    const writes: [string, unknown][] = [
      ['decision_answer', { id: taskDecision, answer: 'Red' }],
      ['decision_cancel', { id: taskDecision }],
      ['control_request', { taskId: 'R1', kind: 'stop' }],
      ['projects_save', { key: 'rules', checkout: '/tmp/x' }],
      ['projects_set', { key: 'rules', autopilot: true }],
    ];
    for (const who of ['coordinator', 'inbox']) {
      for (const [tool, args] of writes) {
        const a = await raw(who, tool, args);
        expect(a.status, `${who} ${tool}`).toBe(403);
        expect(a.error).toContain('“Operator”');
        expect(a.error).toContain('Settings → Factory → Agent tokens');
      }
    }
    for (const [tool, args] of [['inbox_list', {}], ['inbox_answer', { id: 'x', type: 'allow' }]] as const) {
      for (const who of ['coordinator', 'deputy']) {
        const a = await raw(who, tool, args);
        expect(a.status, `${who} ${tool}`).toBe(403);
        expect(a.error).toContain('“Inbox”');
      }
    }
    // nothing changed
    expect((await call('coordinator', 'decision_get', { id: taskDecision })).status).toBe('pending');
    expect((await call('coordinator', 'projects_get', { key: 'rules' })).checkout).toBeNull();
    expect(await call('coordinator', 'control_get', { taskId: 'R1' })).toEqual({ requests: [], acked: false });
  });

  it('reads stay open to every token', async () => {
    expect((await call('coordinator', 'factory_status')).waiting.decisions.some((d: any) => d.id === taskDecision && d.mayAnswer === false)).toBe(true);
    const list = await call('coordinator', 'decisions_list', { status: 'pending' });
    // the coordinator asked it; the inbox token lacks the scope
    expect(list.find((d: any) => d.id === taskDecision)).toMatchObject({ kind: 'question', project: 'rules', mayAnswer: false, why: expect.stringMatching(/asked by this token/) });
    const seen = (await call('inbox', 'decisions_list', { status: 'pending' })).find((d: any) => d.id === taskDecision);
    expect(seen).toMatchObject({ mayAnswer: false, why: expect.stringContaining('“Operator”') });
    expect((await call('deputy', 'decisions_list', { status: 'pending' })).find((d: any) => d.id === taskDecision).mayAnswer).toBe(true);
  });

  it('a token never answers or cancels its own question, compared by token, not by name', async () => {
    const own = (await call('deputy', 'decision_ask', { question: 'Mine?', options: ['Yes', 'No'] })).id;
    for (const tool of ['decision_answer', 'decision_cancel']) {
      const a = await raw('deputy', tool, { id: own, answer: 'Yes' });
      expect(a.status).toBe(403);
      expect(a.error).toMatch(/asked by this token/);
    }
    expect((await call('deputy', 'decisions_list', { status: 'pending' })).find((d: any) => d.id === own)).toMatchObject({ mayAnswer: false, why: expect.stringMatching(/asked by this token/) });
    // another token with the same name is someone else
    expect(await call('deputy2', 'decision_answer', { id: own, answer: 'yes' })).toMatchObject({ status: 'answered', answer: 'Yes', answeredBy: 'agent:deputy' });
    // a decision from before the token was recorded falls back to the name: neither "deputy" may answer it
    srv.ctx.db.run("INSERT INTO decisions (id, question, status, asked_by, created_at) VALUES ('old-1', 'Old one?', 'pending', 'agent:deputy', ?)", Date.now());
    for (const who of ['deputy', 'deputy2']) expect((await raw(who, 'decision_answer', { id: 'old-1', answer: 'ok' })).status).toBe(403);
    expect((await raw('coordinator', 'decision_get', { id: 'old-1' })).result.status).toBe('pending');
  });

  it('no agent answers a launch approval', async () => {
    const launch = await call('launcher', 'tasks_launch', { taskId: 'R1', machineId: machine.id, cwd: srv.dataDir });
    expect(launch.status).toBe('pending_approval');
    for (const who of ['deputy', 'deputy2']) {
      for (const tool of ['decision_answer', 'decision_cancel']) {
        const a = await raw(who, tool, { id: launch.decisionId, answer: 'Launch' });
        expect(a.status).toBe(403);
        expect(a.error).toMatch(/launch approval/);
      }
    }
    expect((await call('deputy', 'decisions_list', { status: 'pending' })).find((d: any) => d.id === launch.decisionId)).toMatchObject({ kind: 'launch_approval', mayAnswer: false });
    expect((await call('deputy', 'factory_status')).waiting.decisions.find((d: any) => d.id === launch.decisionId)).toMatchObject({ kind: 'launch_approval', mayAnswer: false });
    // the owner still can
    expect(await web.post(`/api/decisions/${launch.decisionId}/answer`, { answer: 'Refuse' })).toMatchObject({ status: 'answered', answeredBy: 'web' });
    expect((await call('launcher', 'tasks_launch', { taskId: 'R1', machineId: machine.id, cwd: srv.dataDir })).status).toBe('refused');
  });

  it('answers must be one of the options when there are some, and are recorded with who answered', async () => {
    const bad = await raw('deputy', 'decision_answer', { id: taskDecision, answer: 'Green' });
    expect(bad.status).toBe(400);
    expect(bad.error).toBe('the answer must be one of its options: "Red", "Blue"');
    const d = await call('deputy', 'decision_answer', { id: taskDecision, answer: '  blue ' });
    expect(d).toMatchObject({ status: 'answered', answer: 'Blue', answeredBy: 'agent:deputy' });
    expect(audit('decision_answered', taskDecision).map((a) => a.actor)).toEqual(['agent:deputy']);
    expect((await raw('deputy2', 'decision_answer', { id: taskDecision, answer: 'Red' })).status).toBe(409);
    expect((await raw('deputy', 'decision_cancel', { id: 'nope' })).status).toBe(404);
    // free text without options; cancel
    const free = (await call('coordinator', 'decision_ask', { question: 'Anything to add?' })).id;
    expect(await call('deputy', 'decision_answer', { id: free, answer: 'Ship it on Friday' })).toMatchObject({ answer: 'Ship it on Friday' });
    const drop = (await call('coordinator', 'decision_ask', { question: 'Still needed?' })).id;
    expect(await call('deputy', 'decision_cancel', { id: drop })).toMatchObject({ status: 'cancelled', answer: null, answeredBy: 'agent:deputy' });
    // the web shows who answered
    const all = await web.get('/api/decisions');
    expect(all.find((x: any) => x.id === taskDecision).answeredBy).toBe('agent:deputy');
  });
});

describe('decisions by project, controls and idempotency', () => {
  beforeAll(async () => {
    await web.post('/api/factory/projects', { key: 'alpha', name: 'Alpha' });
    await web.post('/api/factory/projects', { key: 'beta', name: 'Beta' });
    await web.post('/api/tasks', { project: 'alpha', id: 'A1', title: 'Alpha one', status: 'blocata' });
    await web.post('/api/tasks', { project: 'beta', id: 'B1', title: 'Beta one', status: 'la_porti' });
  });

  it('filters decisions by project and status and names their kind', async () => {
    srv.ctx.db.run(
      `INSERT INTO decisions (id, task_id, question, options_json, status, asked_by, created_at) VALUES
       ('rl-1', 'A1', 'A1 failed G2 in its last round', '["Încă o rundă","Oprește pachetul"]', 'pending', 'factory:rounds', ?),
       ('ln-1', 'B1', 'B1 needs attention', '["Retry","Stop the package"]', 'pending', 'factory:line', ?)`,
      Date.now(), Date.now(),
    );
    const alpha = await call('deputy', 'decisions_list', { project: 'alpha' });
    expect(alpha.map((d: any) => [d.id, d.kind, d.project])).toEqual([['rl-1', 'round_limit', 'alpha']]);
    expect((await call('deputy', 'decisions_list', { project: 'beta', status: 'pending' })).map((d: any) => [d.id, d.kind])).toEqual([['ln-1', 'line']]);
    expect(await call('deputy', 'decisions_list', { project: 'beta', status: 'answered' })).toEqual([]);
    expect((await raw('deputy', 'decisions_list', { project: 'nope' })).status).toBe(404);
    expect((await call('deputy', 'decisions_list', { limit: 2 })).length).toBe(2);
    expect(await call('deputy', 'decision_answer', { id: 'rl-1', answer: 'încă o rundă' })).toMatchObject({ answer: 'Încă o rundă' });
  });

  it('control_request reaches control_get, audited as the operator', async () => {
    const c = await call('deputy', 'control_request', { taskId: 'B1', kind: 'stop', note: '  the owner asked  ' });
    expect(c).toMatchObject({ taskId: 'B1', kind: 'stop', note: 'the owner asked', status: 'open' });
    const got = await call('coordinator', 'control_get', { taskId: 'B1' });
    expect(got.requests.map((r: any) => r.id)).toEqual([c.id]);
    expect(audit('task_stop_request', 'B1').map((a) => a.actor)).toEqual(['agent:deputy']);
    const t = await call('coordinator', 'tasks_get', { id: 'B1' });
    expect(t.events.find((e: any) => e.kind === 'control')).toMatchObject({ actor: 'agent:deputy' });
    expect((await raw('deputy', 'control_request', { taskId: 'nope', kind: 'revert' })).status).toBe(404);
  });

  it('idempotency keys still work for the new writes', async () => {
    const h = { 'idempotency-key': 'op-control-1' };
    const first = await raw('deputy', 'control_request', { taskId: 'A1', kind: 'revert' }, h);
    const again = await raw('deputy', 'control_request', { taskId: 'A1', kind: 'revert' }, h);
    expect(first.status).toBe(200);
    expect(again).toMatchObject({ status: 200, replayed: true, result: first.result });
    expect((await call('coordinator', 'control_get', { taskId: 'A1' })).requests.length).toBe(1);

    const q = (await call('coordinator', 'decision_ask', { question: 'Once?', options: ['Yes', 'No'] })).id;
    const k = { 'idempotency-key': `op-answer-${q}` };
    const a1 = await raw('deputy', 'decision_answer', { id: q, answer: 'Yes' }, k);
    const a2 = await raw('deputy', 'decision_answer', { id: q, answer: 'Yes' }, k);
    expect(a1.result.status).toBe('answered');
    expect(a2).toMatchObject({ status: 200, replayed: true, result: a1.result });
    const p1 = await raw('deputy', 'projects_set', { key: 'beta', autopilot: true }, { 'idempotency-key': 'op-set-beta' });
    const p2 = await raw('deputy', 'projects_set', { key: 'beta', autopilot: true }, { 'idempotency-key': 'op-set-beta' });
    expect(p2).toMatchObject({ replayed: true, result: { key: 'beta', autopilot: true } });
    expect(p1.result.autopilot).toBe(true);
  });
});

describe('projects', () => {
  it('projects_save creates and changes projects, including where the line runs', async () => {
    const created = await call('deputy', 'projects_save', {
      key: 'shop', name: 'Shop', repo: 'acme/shop', idPrefix: 'SH-', machineId: machine.id, checkout: '/src/shop', lineFile: 'factory.json',
      config: { limits: { workers: 3 }, models: null },
    });
    expect(created).toMatchObject({ created: true, project: { key: 'shop', idPrefix: 'SH-', machineId: machine.id, machineName: 'box', checkout: '/src/shop', config: { limits: { workers: 3 } } } });
    expect(audit('project_create', 'shop').map((a) => a.actor)).toEqual(['agent:deputy']);
    const changed = await call('deputy', 'projects_save', { key: 'shop', checkout: '/src/shop-main', lineFile: 'ops/line.json', config: { limits: null, integrate: { approval: 'always' } } });
    expect(changed).toMatchObject({ created: false, project: { name: 'Shop', repo: 'acme/shop', checkout: '/src/shop-main', lineFile: 'ops/line.json', config: { integrate: { approval: 'always' } } } });
    expect(changed.project.config.limits).toBeUndefined();
    expect(srv.ctx.db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'project_update' AND target = 'shop' AND actor = 'agent:deputy'")!.detail).toContain('checkout');
    expect((await raw('deputy', 'projects_save', { key: 'shop', machineId: 'no-such-machine' })).status).toBe(400);
    expect((await raw('deputy', 'projects_save', { key: 'Bad Key' })).status).toBe(400);
    expect((await raw('deputy', 'projects_save', { key: 'shop2', repo: 'acme/shop' })).status).toBe(409);
    // the security-sensitive fields never move for a token without the scope
    expect((await raw('coordinator', 'projects_save', { key: 'shop', checkout: '/evil' })).status).toBe(403);
    expect((await call('coordinator', 'projects_get', { key: 'shop' })).checkout).toBe('/src/shop-main');
  });

  it('projects_set switches autopilot and moves between states', async () => {
    await call('deputy', 'tasks_create', { project: 'shop', id: 'P1', title: 'Cart' });
    expect(await call('deputy', 'projects_set', { key: 'shop', autopilot: true })).toMatchObject({ autopilot: true, state: 'active' });
    expect(audit('project_autopilot', 'shop').map((a) => a.actor)).toEqual(['agent:deputy']);
    expect(await call('deputy', 'projects_set', { key: 'shop', state: 'paused' })).toMatchObject({ state: 'paused' });
    expect(await call('deputy', 'projects_set', { key: 'shop', state: 'archived', autopilot: false })).toMatchObject({ state: 'archived', autopilot: false, archived: 1 });
    expect((await call('coordinator', 'tasks_get', { id: 'SH-P1' })).archivedAt).not.toBeNull();
    expect((await raw('deputy', 'projects_set', { key: 'shop', autopilot: true })).status).toBe(409);
    expect(await call('deputy', 'projects_set', { key: 'shop', state: 'paused' })).toMatchObject({ state: 'paused', archived: 0 });
    expect(await call('deputy', 'projects_set', { key: 'shop', state: 'active' })).toMatchObject({ state: 'active' });
    expect((await raw('deputy', 'projects_set', { key: 'shop' })).status).toBe(400);
    expect((await raw('deputy', 'projects_set', { key: 'nope', autopilot: true })).status).toBe(404);
  });
});

describe('the Inbox', () => {
  /** a real pending action: the hook's PermissionRequest long-poll, with walk mode on */
  const ask = async (sid: string, tool: string, input: Record<string, unknown>) => {
    await machinePost('/api/ingest', envelope({ session_id: sid, cwd: srv.dataDir, hook_event_name: 'SessionStart' }));
    const res = machinePost('/api/hook/PermissionRequest', envelope({ session_id: sid, cwd: srv.dataDir, hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: input }))
      .then(async (r) => JSON.parse((await r.text()).trim()));
    for (let i = 0; i < 200; i++) {
      const { pending } = await call('inbox', 'inbox_list', { limit: 50 });
      const p = pending.find((x: any) => x.sessionId === sid);
      if (p) return { p, res };
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no pending action');
  };

  it('lists and answers a permission through the web Inbox path', async () => {
    await web.post('/api/global/walk', { on: true });
    const { p, res } = await ask('op-inbox-1', 'Bash', { command: 'npm run deploy' });
    expect(p).toMatchObject({ kind: 'permission', tool: 'Bash', answers: ['allow', 'deny'], detail: expect.stringContaining('npm run deploy') });
    expect((await call('deputy', 'factory_status')).waiting.inbox).toBeGreaterThanOrEqual(1);
    const wrong = await raw('inbox', 'inbox_answer', { id: p.id, type: 'reply', text: 'go on' });
    expect(wrong.status).toBe(400);
    expect(wrong.error).toMatch(/a permission takes allow or deny/);
    expect(await call('inbox', 'inbox_answer', { id: p.id, type: 'deny', message: 'not on prod' })).toEqual({ ok: true });
    const out = await res;
    expect(out.output.hookSpecificOutput.decision).toMatchObject({ behavior: 'deny', message: 'not on prod' });
    const { history } = await web.get('/api/inbox');
    expect(history.find((h: any) => h.id === p.id)).toMatchObject({ status: 'answered', answeredBy: 'agent:inbox' });
    expect(audit('answer', p.id).map((a) => a.actor)).toEqual(['agent:inbox']);
    const again = await raw('inbox', 'inbox_answer', { id: p.id, type: 'allow' });
    expect(again).toMatchObject({ status: 409, error: 'already answered' });
    expect((await raw('inbox', 'inbox_answer', { id: 'nope', type: 'allow' })).status).toBe(404);
  });

  it('answers a question with its options', async () => {
    const questions = [{ question: 'Which database?', header: 'DB', options: [{ label: 'SQLite', description: 'file' }, { label: 'Postgres', description: 'server' }], multiSelect: false }];
    const { p, res } = await ask('op-inbox-2', 'AskUserQuestion', { questions });
    expect(p).toMatchObject({ kind: 'question', answers: ['answers', 'deny'], questions: [{ question: 'Which database?', options: ['SQLite', 'Postgres'], multiSelect: false }] });
    expect((await raw('inbox', 'inbox_answer', { id: p.id, type: 'answers' })).status).toBe(400);
    await call('inbox', 'inbox_answer', { id: p.id, type: 'answers', answers: { 'Which database?': 'SQLite' } });
    const out = await res;
    expect(out.output.hookSpecificOutput.decision.updatedInput.answers).toEqual({ 'Which database?': 'SQLite' });
    await web.post('/api/global/walk', { on: false });
  });
});

describe('factory_status', () => {
  let status: FactoryStatus;
  let size: number;
  beforeAll(async () => {
    // a busy factory: three more projects with packages in every status, pending decisions, an open control
    const long = 'Rework the invoice export so that every customer gets one PDF per month with all lines, taxes and the payment terms';
    await call('deputy', 'projects_save', { key: 'ledger', name: 'Ledger', idPrefix: 'LG-', machineId: machine.id, checkout: '/src/ledger' });
    await call('deputy', 'projects_save', { key: 'portal', name: 'Customer portal', idPrefix: 'PO-' });
    await call('deputy', 'projects_save', { key: 'mobile', name: 'Mobile app', idPrefix: 'MO-' });
    await call('deputy', 'projects_set', { key: 'ledger', autopilot: true });
    await call('deputy', 'projects_set', { key: 'mobile', state: 'paused' });
    const statuses = ['in_lucru', 'in_lucru', 'la_porti', 'blocata', 'gata', 'gata', 'gata', 'gata', 'backlog', 'integrata'] as const;
    for (const project of ['ledger', 'portal', 'mobile']) {
      for (let i = 0; i < statuses.length; i++) {
        await call('coordinator', 'tasks_create', { project, id: `K${i + 1}`, title: i === 0 ? long : `Package ${i + 1} of ${project}`, status: statuses[i] });
      }
    }
    srv.ctx.db.run("UPDATE tasks SET stage = 'G2', round = 2, line_json = ? WHERE id = 'LG-K3'", JSON.stringify({ waiting: 'G2 run', since: Date.now() - 12 * 60_000, attempts: 1 }));
    for (let i = 0; i < 5; i++) {
      await call('coordinator', 'decision_ask', {
        question: `Question ${i + 1}: the worker asks whether the export should also include archived customers, or only the active ones? ${'x'.repeat(i * 20)}`,
        options: ['Include archived customers', 'Only active customers', 'Ask me again tomorrow'],
        taskId: i % 2 ? 'LG-K2' : 'PO-K1',
      });
    }
    await web.post('/api/tasks/LG-K1/control', { kind: 'stop', note: 'pause it' });
    status = await call('deputy', 'factory_status');
    size = JSON.stringify(status).length;
  });

  it('gives the governor, alerts, projects, the line, ready packages and what waits', () => {
    expect(status.governor).toMatchObject({ canStart: true, stopAll: false, fiveHourPct: 10, sevenDayPct: 20 });
    // the ledger's runner is not connected: its autopilot is held
    expect(status.alerts.some((a) => /^runner offline on box \(.*ledger\)$/.test(a))).toBe(true);
    expect(status.alerts.find((a) => a.startsWith('autopilot held:'))).toContain('ledger (runner offline)');
    const keys = status.projects.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['ledger', 'portal', 'mobile', 'rules', 'alpha', 'beta']));
    expect(status.projects.find((p) => p.key === 'mobile')).toMatchObject({ state: 'paused', autopilot: false, counts: { in_lucru: 2, la_porti: 1, blocata: 1, gata: 4, backlog: 1, integrata: 1 } });
    expect(status.projects.find((p) => p.key === 'ledger')).toMatchObject({ autopilot: true, machine: 'box', runnerOnline: false });
    expect(status.projects.find((p) => p.key === 'rules')!.counts).toEqual({ in_lucru: 1 }); // zeros left out

    const lg1 = status.line.find((t) => t.id === 'LG-K1')!;
    expect(lg1.title.length).toBeLessThanOrEqual(80);
    expect(lg1.title.endsWith('…')).toBe(true);
    expect(lg1.waits).toBe('stop request');
    expect(lg1).not.toHaveProperty('stage'); // null fields are left out
    expect(lg1).not.toHaveProperty('round');
    expect(status.line.find((t) => t.id === 'LG-K3')).toMatchObject({ stage: 'G2', waits: 'G2 run', sinceMin: 12, status: 'la_porti', round: 2, maxRounds: 3 });
    expect(status.line.find((t) => t.id === 'LG-K2')).toMatchObject({ waits: 'decision' });
    expect(status.line.find((t) => t.id === 'LG-K4')).toMatchObject({ status: 'blocata', waits: 'owner' });
    expect(status.line[0].status).toBe('blocata');
    expect(status.line.length).toBeLessThanOrEqual(20);
    expect(status.line.length + status.lineMore).toBe(srv.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE archived_at IS NULL AND status IN ('in_lucru','la_porti','blocata') AND (project IS NULL OR project IN (SELECT key FROM factory_projects WHERE state != 'archived'))")!.n);
    expect(status.ready.length).toBe(10);
    expect(status.readyMore).toBeGreaterThan(0);
    expect(status.ready[0]).toEqual({ id: expect.any(String), project: expect.any(String), title: expect.any(String) }); // priority 0 left out

    const qs = status.waiting.decisions;
    expect(qs.length).toBeGreaterThanOrEqual(5);
    expect(qs.every((d) => d.question.length <= 100)).toBe(true);
    expect(qs.find((d) => d.question.startsWith('Question 2'))).toMatchObject({ kind: 'question', taskId: 'LG-K2', mayAnswer: true, options: ['Include archived customers', 'Only active customers', 'Ask me again tomorrow'] });
    expect(status.waiting.controls.find((c) => c.taskId === 'LG-K1')).toMatchObject({ kind: 'stop', ageMin: 0 });
    // no bodies, histories or belts
    const text = JSON.stringify(status);
    for (const k of ['"body"', '"events"', '"belt"', '"context"', '"gateResults"']) expect(text).not.toContain(k);
  });

  it(`stays small: under 6 KB on this seeded factory`, () => {
    console.log(`factory_status: ${size} bytes, ${status.line.length}+${status.lineMore} on the line, ${status.ready.length}+${status.readyMore} ready, ${status.waiting.decisions.length}+${status.waiting.decisionsMore} decisions`);
    expect(size).toBeLessThan(6 * 1024);
  });

  it('narrows to one project', async () => {
    const one: FactoryStatus = await call('coordinator', 'factory_status', { project: 'ledger' });
    expect(one.projects.map((p) => p.key)).toEqual(['ledger']);
    expect(new Set(one.line.map((t) => t.project))).toEqual(new Set(['ledger']));
    expect(one.ready.every((t) => t.project === 'ledger')).toBe(true);
    expect(one.waiting.decisions.every((d) => d.taskId?.startsWith('LG-'))).toBe(true);
    expect(one.waiting.decisions.length).toBe(2);
    expect(one.waiting.decisions.every((d) => !d.mayAnswer)).toBe(true); // a token without "Operator"
    expect((await raw('coordinator', 'factory_status', { project: 'nope' })).status).toBe(404);
  });
});

describe('the digest', () => {
  it('lists the decisions operators answered, with who and the answer', () => {
    const d = digestData(srv.ctx);
    expect(d.operatorAnswers!.some((a) => a.by === 'deputy' && a.question === 'Red or blue?' && a.answer === 'Blue' && a.taskId === 'R1')).toBe(true);
    expect(d.operatorAnswers!.some((a) => a.question === 'Still needed?' && a.answer === null)).toBe(true);
    expect(d.operatorAnswers!.every((a) => a.by !== 'web')).toBe(true);
    const { body } = digestText(d);
    expect(body).toMatch(/Answered by operators: \d+/);
    expect(body).toMatch(/· deputy, rules R1: Red or blue\? → Blue/);
    expect(body).toContain('Still needed? → cancelled');
  });
});

describe('factory_status at its caps', () => {
  it('caps every list and stays bounded with the longest content', async () => {
    await call('deputy', 'projects_save', { key: 'full', name: 'F'.repeat(120), idPrefix: 'FU-' });
    const title = 'T'.repeat(200);
    for (let i = 0; i < 25; i++) await call('coordinator', 'tasks_create', { project: 'full', id: `L${i}`, title, status: 'in_lucru' });
    for (let i = 0; i < 12; i++) await call('coordinator', 'tasks_create', { project: 'full', id: `G${i}`, title, status: 'gata', priority: 5 });
    for (let i = 0; i < 25; i++) {
      await call('coordinator', 'decision_ask', { question: 'Q'.repeat(4000), options: Array.from({ length: 8 }, (_, k) => `${k}${'o'.repeat(299)}`), taskId: `FU-L${i}` });
    }
    for (let i = 0; i < 12; i++) await web.post(`/api/tasks/FU-L${i}/control`, { kind: 'stop', note: 'n'.repeat(4000) });
    const s: FactoryStatus = await call('deputy', 'factory_status', { project: 'full' });
    expect([s.line.length, s.lineMore, s.ready.length, s.readyMore, s.waiting.decisions.length, s.waiting.decisionsMore, s.waiting.controls.length, s.waiting.controlsMore]).toEqual([20, 5, 10, 2, 20, 5, 10, 2]);
    expect(s.projects[0].name.length).toBe(80);
    expect(s.waiting.decisions[0].options.every((o) => o.length === 40)).toBe(true);
    const size = JSON.stringify(s).length;
    console.log(`factory_status at its caps: ${size} bytes`);
    expect(size).toBeLessThan(20 * 1024);
  });
});

describe('the guide', () => {
  it('docs_get topic operator explains the role, the loop and the examples', async () => {
    const md: string = await call('coordinator', 'docs_get', { topic: 'operator' });
    expect(md).toContain("# Buildyboy: the operator's guide");
    for (const s of ['## The loop', 'factory_status', 'launch_approval', 'round_limit', '/api/agent/decision_answer', '"name": "decision_answer"', 'leave it to the owner']) expect(md).toContain(s);
    expect(await call('coordinator', 'docs_get', { topic: 'start' })).toContain('docs_get {topic: "operator"}');
  });
});

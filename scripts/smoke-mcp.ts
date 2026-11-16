// npm run smoke:mcp — end to end: a server on a temporary DB, `bb mcp` spawned over stdio with an agent token,
// and one successful call of every MCP tool. Usage data arrives the real way (hook SessionStart + statusline POST).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer } from '../server/main.ts';
import { createMachine } from '../server/auth.ts';
import { createAgentToken, revokeAgentToken, setTokenLaunch } from '../server/factory/agent.ts';
import { answerDecision, askDecision } from '../server/factory/decisions.ts';
import { requestControl } from '../server/factory/tasks.ts';
import { saveFactoryConfig } from '../server/factory/config.ts';
import { startRunner, type Runner } from '../runner/main.ts';
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
  let runner: Runner | null = null;
  const savedEnv = { home: process.env.BUILDYBOY_HOME, hc: process.env.BUILDYBOY_HC };
  try {
    const machine = createMachine(srv.ctx, 'smoke');
    const post = (path: string, body: unknown) =>
      fetch(`${srv.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${machine.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sid = 'smoke-mcp-session';
    assert((await post('/api/ingest', { v: 1, ts: Date.now(), env: {}, hostname: 'h', platform: process.platform, user: 'u', pid: 1, ppid: 1, hookVersion: 'smoke', event: { session_id: sid, cwd: dir, hook_event_name: 'SessionStart' } })).ok, 'ingest');
    const resets = Math.floor(Date.now() / 1000) + 3600;
    assert((await post('/api/statusline', { session_id: sid, rate_limits: { five_hour: { used_percentage: 12, resets_at: resets }, seven_day: { used_percentage: 30, resets_at: resets + 86400 } } })).ok, 'statusline');

    // the repo's factory config and a runner on this machine, for resources and gates_run
    const checkout = join(dir, 'roots', 'arond');
    mkdirSync(join(checkout, 'gates'), { recursive: true });
    writeFileSync(
      join(checkout, 'gates', 'g1.mjs'),
      `console.log('G1 log line for ' + process.argv[2]);
console.log(JSON.stringify({ verdict: 'pass', summary: 'G1 pass: 3 tests', findings: [{ severity: 'minor', title: 'Slow test' }] }));
`,
    );
    writeFileSync(join(checkout, 'gates', 'recipe.json'), JSON.stringify({ gates: { G1: { steps: [{ argv: [process.execPath, '{recipeDir}/g1.mjs', '{id}'] }] } } }));
    saveFactoryConfig(srv.ctx, {
      maxRounds: 3,
      repos: [{ repo: 'arond', machineId: machine.id, checkout, recipe: 'gates/recipe.json', worktree: join(dir, 'wt', '{id}'), portFrom: 5600, portTo: 5609, dbPrefix: 'arond_', migrationFrom: 40, migrationBlock: 10, cleanup: ['bash curata.sh {id}'] }],
    });
    const runnerHome = join(dir, 'runner-home');
    mkdirSync(runnerHome, { recursive: true });
    writeFileSync(join(runnerHome, 'config.json'), JSON.stringify({ url: srv.url, token: machine.token, machineId: machine.id }));
    writeFileSync(join(runnerHome, 'runner.json'), JSON.stringify({ allowedRoots: [join(dir, 'roots')], concurrency: 1 }));
    process.env.BUILDYBOY_HOME = runnerHome;
    process.env.BUILDYBOY_HC = 'off';
    runner = startRunner({ log: () => {} });

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
    assert(claim.resources?.port === 5600 && claim.resources.db === 'arond_p1' && claim.resources.migrations?.from === 40, 'tasks_claim allocates the resources');
    const projects = await call<any[]>('projects_list');
    assert(projects.length === 1 && projects[0].key === 'arond' && projects[0].counts.in_lucru === 1, 'projects_list: the arond project, P1 in progress');
    const arond = await call('projects_get', { key: 'arond' });
    assert(arond.line.map((t: any) => t.id).join() === 'P1' && claim.task.project === 'arond', 'projects_get: P1 on the line');

    const rendered = await call('prompts_render', { slots: { Goal: 'Build P1', 'Done when': '`pnpm verify` passes' } });
    assert(typeof rendered.rendered === 'string' && rendered.rendered.includes('Build P1'), 'prompts_render');
    const lint = await call('prompts_lint', { slots: { Goal: 'Build P1' } });
    assert(Array.isArray(lint.warnings), 'prompts_lint');
    const saved = await call('prompts_save', { title: 'P1 worker', slots: { Goal: 'Build P1' }, taskId: 'P1' });
    assert(saved.id > 0 && saved.version === 1, 'prompts_save');

    const upd = await call('tasks_update', { id: 'P1', status: 'la_porti', branch: 'pachet/P1', costUsd: 1.25, note: 'worker done', migrationsUsed: [40, 41] });
    assert(upd.status === 'la_porti' && upd.branch === 'pachet/P1' && upd.promptId === saved.id && upd.round === 1, 'tasks_update');

    for (let i = 0; i < 200 && !srv.ctx.runners.has(machine.id); i++) await new Promise((r) => setTimeout(r, 50));
    const run = await call('gates_run', { taskId: 'P1', gate: 'G1' });
    assert(typeof run.runId === 'string' && run.sent === true, 'gates_run sent to the runner');
    let status: any = null;
    for (let i = 0; i < 300 && !(status && (status.status === 'done' || status.status === 'error')); i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await call('gates_status', { runId: run.runId });
    }
    assert(status?.status === 'done' && status.verdict === 'pass' && status.summary === 'G1 pass: 3 tests' && status.gateResultId > 0, `gates_status done (${JSON.stringify(status)})`);
    assert(!JSON.stringify(status).includes('G1 log line'), 'gates_status returns no log text');
    // a kit step on a §11.7 recipe (no "commands"): the runner answers with an error, no verdict, no round
    const step = await call('steps_run', { taskId: 'P1', step: 'prepare' });
    assert(typeof step.runId === 'string' && step.step === 'prepare' && step.sent === true, 'steps_run sent to the runner');
    let stepStatus: any = null;
    for (let i = 0; i < 300 && !(stepStatus && (stepStatus.status === 'done' || stepStatus.status === 'error')); i++) {
      await new Promise((r) => setTimeout(r, 100));
      stepStatus = await call('gates_status', { runId: step.runId });
    }
    assert(stepStatus?.status === 'error' && /without "commands"/.test(stepStatus.error) && stepStatus.gateResultId === null, `steps_run prepare on a recipe is an error (${JSON.stringify(stepStatus)})`);
    const machines = await call<any[]>('machines_list');
    assert(machines.some((m) => m.id === machine.id && m.runnerOnline), 'machines_list: this machine, runner online');
    // launching allowed with the owner's approval: the first call asks and starts nothing
    setTokenLaunch(srv.ctx, agent.id, { launch: 'all', launchApproval: true });
    const launch = await call('tasks_launch', { taskId: 'P2', machineId: machine.id, cwd: checkout });
    assert(launch.status === 'pending_approval' && launch.decisionId, `tasks_launch waits for approval (${JSON.stringify(launch)})`);
    const coord = await call('coordinator_launch', { machineId: machine.id, cwd: checkout });
    assert(coord.status === 'pending_approval', 'coordinator_launch waits for approval');
    answerDecision(srv.ctx, launch.decisionId, null, 'web');
    answerDecision(srv.ctx, coord.decisionId, null, 'web');
    const gate = await call('gates_record', {
      taskId: 'P1', gate: 'G4', verdict: 'pass', summary: 'Desktop and phone look right', screenshots: [{ name: 'desktop', path: shot }],
      findings: [{ severity: 'minor', title: 'Button 2px off on phone', file: 'web/src/x.tsx', line: 4 }],
    });
    assert(gate.shots.length === 1, 'gates_record stored the screenshot');
    const minors = await call<any[]>('findings_list', { status: 'open', severity: 'minor' });
    assert(minors.length === 2, `findings_list: two open minors (${minors.length})`);
    const wont = await call<any[]>('findings_update', { ids: [minors.find((f) => f.title === 'Slow test').id], status: 'wontfix', note: 'fine for now' });
    assert(wont[0].status === 'wontfix', 'findings_update');
    const later = await call('tasks_create', { id: 'P3', title: 'Leftover minors', fromFindings: [minors.find((f) => f.gate === 'G4').id] });
    assert(later.acceptance[0] === 'Fixed: Button 2px off on phone (web/src/x.tsx:4)', 'tasks_create fromFindings');
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

    // operators (§12.7): the owner makes this token an operator and lets it answer the Inbox
    const refused = (await client.callTool({ name: 'control_request', arguments: { taskId: 'P2', kind: 'stop' } })) as { isError?: boolean; content: { text: string }[] };
    assert(refused.isError && /“Operator”/.test(refused.content[0].text), 'control_request needs the Operator switch');
    setTokenLaunch(srv.ctx, agent.id, { operator: true, inbox: true });
    const overview = await call('factory_status');
    assert(overview.projects.some((p: any) => p.key === 'arond') && typeof overview.waiting.inbox === 'number', 'factory_status');
    const other = askDecision(srv.ctx, { question: 'Merge P2 today?', options: ['Yes', 'No'], taskId: 'P2' }, 'agent:another-coordinator');
    const drop = askDecision(srv.ctx, { question: 'Still needed?' }, 'agent:another-coordinator');
    const pending = await call<any[]>('decisions_list', { status: 'pending' });
    assert(pending.find((d) => d.id === other.id)?.mayAnswer === true, 'decisions_list: the operator may answer it');
    const ans = await call('decision_answer', { id: other.id, answer: 'no' });
    assert(ans.answer === 'No' && ans.answeredBy === 'agent:smoke-coordinator', 'decision_answer');
    assert((await call('decision_cancel', { id: drop.id })).status === 'cancelled', 'decision_cancel');
    const stop = await call('control_request', { taskId: 'P2', kind: 'stop', note: 'smoke' });
    assert((await call('control_get', { taskId: 'P2', ack: true })).requests[0]?.id === stop.id, 'control_request reaches control_get');
    const saved2 = await call('projects_save', { key: 'smoke-ops', name: 'Smoke ops', checkout: checkout, machineId: machine.id });
    assert(saved2.created === true && saved2.project.checkout === checkout, 'projects_save');
    assert((await call('projects_set', { key: 'smoke-ops', autopilot: true, state: 'paused' })).state === 'paused', 'projects_set');
    const planned = await call('plan_request', { project: 'smoke-ops', goal: 'Smoke the planner', notes: 'nothing real' });
    assert(planned.status === 'running' && typeof planned.jobId === 'string', 'plan_request starts the planner job');
    srv.ctx.db.setSetting('walk_mode', true);
    const hook = post('/api/hook/PermissionRequest', {
      v: 1, ts: Date.now(), env: {}, hostname: 'h', platform: process.platform, user: 'u', pid: 1, ppid: 1, hookVersion: 'smoke',
      event: { session_id: sid, cwd: dir, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } },
    }).then((r) => r.text());
    let item: any = null;
    for (let i = 0; i < 200 && !item; i++) {
      item = (await call('inbox_list')).pending.find((p: any) => p.sessionId === sid) ?? null;
      if (!item) await new Promise((r) => setTimeout(r, 25));
    }
    assert(item?.kind === 'permission', 'inbox_list shows the permission');
    assert((await call('inbox_answer', { id: item.id, type: 'allow' })).ok === true, 'inbox_answer');
    assert(JSON.parse((await hook).trim()).output?.hookSpecificOutput?.decision?.behavior === 'allow', 'the session got the answer');
    srv.ctx.db.setSetting('walk_mode', false);
    log('✔ operator tools: status, decisions, control, projects, the Inbox');

    const integrated = await call('tasks_update', { id: 'P1', status: 'integrata' });
    assert(integrated.cleanup?.[0] === 'bash curata.sh P1', 'integration returns the cleanup list');
    assert((await call<any[]>('tasks_list', { ready: true })).some((t) => t.id === 'P2'), 'P2 ready once P1 is integrated');
    assert((await call('tasks_get', { id: 'P1' })).gateResults.length === 2, 'tasks_get');
    const digest = await call('digest_post', { note: 'smoke' });
    assert(/P1/.test(digest.body), 'digest_post mentions P1');
    const guide = await client.callTool({ name: 'docs_get', arguments: { tool: 'tasks_claim' } }) as { content: { text: string }[]; isError?: boolean };
    assert(!guide.isError && guide.content[0].text.startsWith('### tasks_claim'), 'docs_get answers Markdown');
    called.add('docs_get');

    for (const n of TOOL_NAMES) assert(called.has(n), `tool ${n} was called`);
    log(`✔ all ${called.size} tools answered: ${[...called].join(', ')}`);

    // the same tools over the server's Streamable HTTP endpoint
    const http = new Client({ name: 'bb-smoke-http', version: '1.0.0' });
    await http.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${agent.token}` } } }));
    const httpTools = (await http.listTools()).tools.map((t) => t.name);
    for (const n of TOOL_NAMES) assert(httpTools.includes(n), `tool ${n} is listed over HTTP`);
    const httpTask = (await http.callTool({ name: 'tasks_get', arguments: { id: 'P1' } })) as { content: { text: string }[]; isError?: boolean };
    assert(!httpTask.isError && JSON.parse(httpTask.content[0].text).status === 'integrata', 'tasks_get over HTTP');
    await http.close();
    log(`✔ /mcp over Streamable HTTP lists the same ${httpTools.length} tools and answers`);

    revokeAgentToken(srv.ctx, agent.id);
    const denied = (await client.callTool({ name: 'usage_get', arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    assert(denied.isError && /unauthorized/.test(denied.content[0].text), 'revoked token is refused');
    log('✔ a revoked agent token is refused');
  } finally {
    await runner?.stop().catch(() => {});
    process.env.BUILDYBOY_HOME = savedEnv.home;
    process.env.BUILDYBOY_HC = savedEnv.hc;
    if (savedEnv.home === undefined) delete process.env.BUILDYBOY_HOME;
    if (savedEnv.hc === undefined) delete process.env.BUILDYBOY_HC;
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

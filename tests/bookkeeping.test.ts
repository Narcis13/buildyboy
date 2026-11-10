// The factory's bookkeeping (SPEC §11.7): gate rounds and the round limit, cost from tagged sessions, gates run by the
// runner from a recipe, resources and migration collisions, structured findings. Never touches ~/.buildyboy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, type TestServer, type WebClient } from './helpers.ts';
import { createMachine } from '../server/auth.ts';
import { createAgentToken } from '../server/factory/agent.ts';
import { startRunner, type Runner } from '../runner/main.ts';

let srv: TestServer;
let web: WebClient;
let token: string;
let machine: { id: string; token: string };
let tmp: string;
let runner: Runner | null = null;

const agent = async (tool: string, body: unknown = {}) => {
  const r = await fetch(`${srv.url}/api/agent/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json()) as { result?: any; error?: string };
  if (!r.ok) throw new Error(`${tool} ${r.status} ${j.error}`);
  return j.result;
};
const machinePost = (path: string, body: unknown) =>
  fetch(`${srv.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${machine.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const hook = (sid: string, env: Record<string, string>, name = 'SessionStart') =>
  machinePost('/api/ingest', { v: 1, ts: Date.now(), env, hostname: 'h', platform: process.platform, user: 'u', pid: 1, ppid: 1, hookVersion: 't', event: { session_id: sid, cwd: tmp, hook_event_name: name } });

async function waitFor<T>(fn: () => Promise<T> | T, what: string, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  srv = await startTestServer();
  srv.ctx.notify = () => {};
  web = await srv.login();
  token = createAgentToken(srv.ctx, 'coordinator').token;
  machine = createMachine(srv.ctx, 'box', { platform: process.platform });
  tmp = mkdtempSync(join(tmpdir(), 'bb-books-'));
});
afterAll(async () => {
  await runner?.stop();
  await srv.stop();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows may hold files briefly
  }
});

describe('gate rounds', () => {
  it('(b) three failing rounds block the package with one decision; an approved extra round allows round 4', async () => {
    await agent('tasks_create', { id: 'R1', title: 'Rounds', status: 'gata' });
    await agent('tasks_claim', { id: 'R1', force: true });
    expect(await agent('tasks_get', { id: 'R1' })).toMatchObject({ round: 0, maxRounds: 3 });
    for (let round = 1; round <= 3; round++) {
      await agent('tasks_update', { id: 'R1', status: 'la_porti' });
      await agent('gates_record', { taskId: 'R1', gate: 'G1', verdict: 'pass', summary: 'green' });
      const g = await agent('gates_record', { taskId: 'R1', gate: 'G2', verdict: 'fail', summary: `red ${round}` });
      expect(g.round).toBe(round);
      const t = await agent('tasks_get', { id: 'R1' });
      expect(t.round).toBe(round);
      if (round < 3) {
        expect(t.status).toBe('la_porti');
        await agent('tasks_update', { id: 'R1', status: 'in_lucru', note: 'fix G2' });
        expect((await agent('tasks_get', { id: 'R1' })).maxRounds).toBe(3); // not from blocata: no extra round
      }
    }
    let t = await agent('tasks_get', { id: 'R1' });
    expect(t).toMatchObject({ status: 'blocata', round: 3, maxRounds: 3 });
    const pending = t.decisions.filter((d: any) => d.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].options).toEqual(['Încă o rundă', 'Încă o rundă, doar pentru G2', 'Oprește pachetul']);
    // another failure in the same round does not ask twice
    await agent('gates_record', { taskId: 'R1', gate: 'G2', verdict: 'fail', summary: 'still red' });
    expect((await agent('tasks_get', { id: 'R1' })).decisions.filter((d: any) => d.status === 'pending')).toHaveLength(1);

    // round 4 is refused until the extra round is approved
    await expect(agent('tasks_update', { id: 'R1', status: 'la_porti' })).rejects.toThrow(/409.*3 gate rounds/);
    await web.post(`/api/decisions/${pending[0].id}/answer`, { answer: 'Încă o rundă' });
    await agent('tasks_update', { id: 'R1', status: 'in_lucru', note: 'Narcis: one more round' });
    expect(await agent('tasks_get', { id: 'R1' })).toMatchObject({ status: 'in_lucru', maxRounds: 4 });
    await agent('tasks_update', { id: 'R1', status: 'la_porti' });
    const g4 = await agent('gates_record', { taskId: 'R1', gate: 'G2', verdict: 'pass', summary: 'green at last' });
    expect(g4.round).toBe(4);
    t = await agent('tasks_get', { id: 'R1' });
    expect(t).toMatchObject({ status: 'la_porti', round: 4, maxRounds: 4 });
  });

  it('gate_max_rounds comes from the factory config', async () => {
    const cfg = await web.get('/api/factory/config');
    expect(cfg).toEqual({ maxRounds: 3, repos: [] });
    await web.put('/api/factory/config', { maxRounds: 1, repos: [] });
    await agent('tasks_create', { id: 'R2', title: 'One round' });
    const g = await agent('gates_record', { taskId: 'R2', gate: 'G1', verdict: 'fail', summary: 'red' }); // no move into la_porti: round 1
    expect(g.round).toBe(1);
    expect(await agent('tasks_get', { id: 'R2' })).toMatchObject({ status: 'blocata', round: 1, maxRounds: 1 });
    await web.put('/api/factory/config', { maxRounds: 3, repos: [] });
  });
});

describe('cost', () => {
  it('(c) two sessions tagged BB_TASK=P9 make the cost their exact sum, split by role', async () => {
    await agent('tasks_create', { id: 'P9', title: 'Costed' });
    await agent('tasks_update', { id: 'P9', costUsd: 9.99 });
    expect((await agent('tasks_get', { id: 'P9' })).costUsd).toBe(9.99); // nothing linked yet: the hand value
    expect((await hook('cost-w', { BB_TASK: 'P9', BB_ROLE: 'lucrator' })).ok).toBe(true);
    expect((await hook('cost-g', { BB_TASK: 'P9', BB_ROLE: 'poarta' })).ok).toBe(true);
    await hook('cost-other', {});
    await machinePost('/api/statusline', { session_id: 'cost-w', cost: { total_cost_usd: 1.234567 } });
    await machinePost('/api/statusline', { session_id: 'cost-g', cost: { total_cost_usd: 0.45 } });
    await machinePost('/api/statusline', { session_id: 'cost-other', cost: { total_cost_usd: 100 } });
    const t = await agent('tasks_get', { id: 'P9' });
    expect(t.costUsd).toBe(1.684567);
    expect(t.costByRole).toEqual({ lucrator: 1.234567, poarta: 0.45 });
    expect(t.costManualUsd).toBe(9.99);
    expect(t.linkedSessions).toBe(2);
    // a session linked through the herdr terminal (tasks.session_id) counts as lucrator, once
    await hook('cost-herdr', {});
    await machinePost('/api/statusline', { session_id: 'cost-herdr', cost: { total_cost_usd: 1 } });
    await agent('tasks_update', { id: 'P9', sessionId: 'cost-herdr' });
    const u = (await agent('tasks_list', {})).find((x: any) => x.id === 'P9');
    expect(u.costByRole).toEqual({ lucrator: 2.234567, poarta: 0.45 });
    expect(u.costUsd).toBe(2.684567);
  });
});

describe('resources', () => {
  it('(e) claims get different ports and non-overlapping migration ranges; an overlapping integration warns the other package', async () => {
    await web.put('/api/factory/config', {
      maxRounds: 3,
      repos: [{ repo: 'shop', portFrom: 4100, portTo: 4109, dbPrefix: 'shop_', migrationFrom: 30, migrationBlock: 10, cleanup: ['bash curata.sh {id}', 'dropdb {db}', 'port {port}'] }],
    });
    await agent('tasks_create', { id: 'M1', title: 'One', repo: 'shop', status: 'gata' });
    await agent('tasks_create', { id: 'M2', title: 'Two', repo: 'Shop', status: 'gata' });
    const a = await agent('tasks_claim', { id: 'M1', force: true });
    const b = await agent('tasks_claim', { id: 'M2', force: true });
    expect(a.resources).toEqual({ port: 4100, db: 'shop_m1', migrations: { from: 30, to: 39 } });
    expect(b.resources).toEqual({ port: 4101, db: 'shop_m2', migrations: { from: 40, to: 49 } });
    expect((await agent('tasks_get', { id: 'M2' })).resources).toEqual(b.resources);

    // M1 used numbers from M2's range (it renumbered into it): integrating M1 warns M2 and the digest
    await agent('tasks_update', { id: 'M1', migrationsUsed: [31, 41, 42] });
    const done = await agent('tasks_update', { id: 'M1', status: 'integrata' });
    expect(done.cleanup).toEqual(['bash curata.sh M1', 'dropdb shop_m1', 'port 4100']);
    expect(done.warnings).toHaveLength(1);
    const m2 = await agent('tasks_get', { id: 'M2' });
    const warning = m2.events.find((e: any) => e.kind === 'warning');
    expect(warning.detail).toMatchObject({ from: 'M1', migrations: [41, 42] });
    expect(warning.detail.message).toMatch(/renumber M2/);
    const digest = await agent('digest_post', {});
    expect(digest.body).toMatch(/Warning M2: .*41, 42.*renumber/);

    // M1's port is free again; the next range starts after everything recorded
    await agent('tasks_create', { id: 'M3', title: 'Three', repo: 'shop', status: 'gata' });
    expect((await agent('tasks_claim', { id: 'M3', force: true })).resources).toEqual({ port: 4100, db: 'shop_m3', migrations: { from: 50, to: 59 } });
    // no config for the repo: no resources, as before
    await agent('tasks_create', { id: 'M4', title: 'Four', status: 'gata' });
    expect((await agent('tasks_claim', { id: 'M4', force: true })).resources).toBeNull();
  });
});

describe('findings', () => {
  it('(f) open on a failed round, fixed by a later pass (minors stay open), deferred into a new package', async () => {
    await agent('tasks_create', { id: 'F1', title: 'Findings' });
    await agent('gates_record', {
      taskId: 'F1', gate: 'G3', verdict: 'fail', summary: 'review red',
      findings: [
        { severity: 'blocker', title: 'SQL injection in search', file: 'src/search.ts', line: 12, fix: 'use parameters' },
        { severity: 'major', title: 'No test for empty input' },
        { severity: 'minor', title: 'Typo in label', file: 'src/ui.tsx', line: 3, detail: 'Salvează, not Salveaza' },
      ],
    });
    await agent('gates_record', { taskId: 'F1', gate: 'G4', verdict: 'fail', summary: 'visual red', findings: [{ severity: 'major', title: 'Overflow on phone' }] });
    let list = await agent('findings_list', { taskId: 'F1' });
    expect(list.map((f: any) => f.status)).toEqual(['open', 'open', 'open', 'open']);
    expect((await agent('tasks_get', { id: 'F1' })).openFindings).toEqual({ blocker: 1, major: 2, minor: 1 });

    await agent('gates_record', { taskId: 'F1', gate: 'G3', verdict: 'pass', summary: 'review green' });
    list = await agent('findings_list', { taskId: 'F1' });
    const by = (title: string) => list.find((f: any) => f.title === title);
    expect(by('SQL injection in search').status).toBe('fixed');
    expect(by('No test for empty input').status).toBe('fixed');
    expect(by('Typo in label').status).toBe('open');
    expect(by('Overflow on phone').status).toBe('open'); // another gate's finding

    const minors = await agent('findings_list', { status: 'open', severity: 'minor' });
    expect(minors.map((f: any) => f.title)).toEqual(['Typo in label']);
    const created = await agent('tasks_create', { id: 'F2', title: 'Leftover minors', fromFindings: [minors[0].id] });
    const f2 = await agent('tasks_get', { id: created.id });
    expect(f2.body).toMatch(/\[minor\] Typo in label.*F1 G3, round 1/);
    expect(f2.body).toMatch(/src\/ui\.tsx:3/);
    expect(f2.acceptance).toEqual(['Fixed: Typo in label (src/ui.tsx:3)']);
    expect((await agent('findings_list', { taskId: 'F1', severity: 'minor' }))[0]).toMatchObject({ status: 'deferred', deferredTo: 'F2' });
    await expect(agent('tasks_create', { id: 'F3', title: 'x', fromFindings: [999999] })).rejects.toThrow(/400.*unknown finding/);

    const upd = await agent('findings_update', { ids: [by('Overflow on phone').id], status: 'for_architect', note: 'needs a layout decision' });
    expect(upd[0]).toMatchObject({ status: 'for_architect', note: 'needs a layout decision' });
    expect((await web.get('/api/findings?status=for_architect')).map((f: any) => f.id)).toEqual([by('Overflow on phone').id]);
  });
});

describe('gates run by the runner', () => {
  it('(d) gates_run runs the recipe step, records verdict, summary and findings, keeps the log and returns none of it', async () => {
    const home = join(tmp, 'home');
    const roots = join(tmp, 'roots');
    const checkout = join(roots, 'shop');
    for (const d of [home, join(checkout, 'gates')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ url: srv.url, token: machine.token, machineId: machine.id }));
    writeFileSync(join(home, 'runner.json'), JSON.stringify({ allowedRoots: [roots], concurrency: 1 }));
    writeFileSync(
      join(checkout, 'gates', 'g3.mjs'),
      `const [id, round, port, ...rest] = process.argv.slice(2);
console.log('reviewing ' + id + ' round ' + round + ' on port ' + port + ' as ' + process.env.BB_ROLE + ' for ' + process.env.BB_TASK);
console.log('SECRET-LOG-LINE');
console.log(JSON.stringify({ verdict: 'fail', summary: 'G3 fail: 1 major', details: { args: rest }, findings: [{ severity: 'major', title: 'Missing check', file: 'a.ts', line: 7 }] }));
process.exit(1);
`,
    );
    writeFileSync(join(checkout, 'gates', 'recipe.json'), JSON.stringify({ gates: { G3: { steps: [{ name: 'review', argv: [process.execPath, '{recipeDir}/g3.mjs', '{id}', '{round}', '{port}', '{args}'], timeoutSec: 60 }] } } }));
    await web.put('/api/factory/config', {
      maxRounds: 3,
      repos: [{ repo: 'shop', machineId: machine.id, checkout, recipe: 'gates/recipe.json', worktree: join(tmp, 'wt', '{id}'), portFrom: 4100, portTo: 4109, dbPrefix: 'shop_', migrationFrom: 30, migrationBlock: 10, cleanup: [] }],
    });
    await agent('tasks_create', { id: 'D1', title: 'Gated by the runner', repo: 'shop', status: 'gata' });
    const claim = await agent('tasks_claim', { id: 'D1', force: true });
    await agent('tasks_update', { id: 'D1', status: 'la_porti' });

    process.env.BUILDYBOY_HOME = home;
    process.env.BUILDYBOY_HC = 'off';
    process.env.BUILDYBOY_CLAUDE_BIN = join(tmp, 'no-claude');
    delete process.env.BUILDYBOY_URL;
    delete process.env.BUILDYBOY_TOKEN;
    runner = startRunner({ log: () => {} });
    await waitFor(() => srv.ctx.runners.has(machine.id), 'the runner to connect');

    const started = await agent('gates_run', { taskId: 'D1', gate: 'G3', args: ['--sensibil'] });
    expect(started).toMatchObject({ status: 'queued', round: 1, sent: true });
    const done = await waitFor(async () => {
      const s = await agent('gates_status', { runId: started.runId });
      return s.status === 'done' || s.status === 'error' ? s : null;
    }, 'the gate run to finish');
    expect(done).toMatchObject({ status: 'done', verdict: 'fail', summary: 'G3 fail: 1 major', exitCode: 1, findings: [{ severity: 'major', title: 'Missing check', file: 'a.ts', line: 7 }] });
    expect(JSON.stringify(done)).not.toMatch(/SECRET-LOG-LINE|reviewing/);
    expect(done.logBytes).toBeGreaterThan(0);

    const t = await agent('tasks_get', { id: 'D1' });
    const g = t.gateResults.find((x: any) => x.id === done.gateResultId);
    expect(g).toMatchObject({ gate: 'G3', verdict: 'fail', round: 1, actor: 'runner:gate', details: { details: { args: ['--sensibil'] }, runId: started.runId, exitCode: 1 } });
    expect(t.findings).toMatchObject([{ title: 'Missing check', status: 'open', gateResultId: done.gateResultId }]);
    expect(JSON.stringify(t)).not.toMatch(/SECRET-LOG-LINE/);

    const log = await web.text(`/api/gate-runs/${started.runId}/log`);
    expect(log).toContain('SECRET-LOG-LINE');
    expect(log).toContain(`reviewing D1 round 1 on port ${claim.resources.port} as poarta for D1`);

    // the report endpoint is the runner's, and only for its own runs
    expect((await fetch(`${srv.url}/api/runner/gates/${started.runId}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"status":"done"}' })).status).toBe(401);
    // a gate the recipe lacks is an error, not a verdict: no gate result, no round used
    const missing = await agent('gates_run', { taskId: 'D1', gate: 'G5' });
    const err = await waitFor(async () => {
      const s = await agent('gates_status', { runId: missing.runId });
      return s.status === 'error' ? s : null;
    }, 'the missing gate to fail');
    expect(err.error).toMatch(/G5/);
    expect((await agent('tasks_get', { id: 'D1' })).gateResults.filter((x: any) => x.gate === 'G5')).toEqual([]);
  });
});

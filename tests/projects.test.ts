// Factory projects, package ids and the archive (SPEC §12.1, §12.2, §12.10): migration 009 on pre-009 data, project
// CRUD and states, id prefixes, claiming across projects, the archive and its sweep, the /api/factory/config shim, and
// resources and gate runs resolved through the package's project.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, type TestServer, type WebClient } from './helpers.ts';
import { DB } from '../server/db.ts';
import { createMachine } from '../server/auth.ts';
import { createAgentToken } from '../server/factory/agent.ts';
import { archiveSweep } from '../server/factory/projects.ts';
import { digestText, type DigestData } from '../server/factory/digest.ts';
import { tasksCli } from '../cli/tasks.ts';

let srv: TestServer;
let web: WebClient;
let token: string;
let opToken: string;
let tmp: string;

const call = async (tok: string, tool: string, body: unknown = {}) => {
  const r = await fetch(`${srv.url}/api/agent/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json()) as { result?: any; error?: string };
  if (!r.ok) throw new Error(`${tool} ${r.status} ${j.error}`);
  return j.result;
};
const agent = (tool: string, body: unknown = {}) => call(token, tool, body);
/** an operator token (§12.7): may archive packages */
const op = (tool: string, body: unknown = {}) => call(opToken, tool, body);
const ids = (list: { id: string }[]) => list.map((t) => t.id);

beforeAll(async () => {
  srv = await startTestServer();
  srv.ctx.notify = () => {};
  web = await srv.login();
  token = createAgentToken(srv.ctx, 'coordinator').token;
  const o = createAgentToken(srv.ctx, 'operator');
  srv.ctx.db.run('UPDATE agent_tokens SET operator = 1 WHERE id = ?', o.id);
  opToken = o.token;
  tmp = mkdtempSync(join(tmpdir(), 'bb-projects-'));
});
afterAll(async () => {
  await srv.stop();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows may hold files briefly
  }
});

describe('migration 009', () => {
  it('makes a project per configured repo and per other repo, assigns packages by repo and archives integrated ones', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bb-m009-'));
    const now = Date.now();
    // a database as it was before 009: the §11.7 per-repo config in settings, packages in several repos
    const old = new DB(join(dataDir, 'buildyboy.db'), { stopBefore: '009' });
    expect(old.get("SELECT 1 FROM sqlite_master WHERE name = 'factory_projects'")).toBeUndefined();
    old.run("INSERT INTO machines (id, name, first_seen) VALUES ('m-arond', 'box', ?)", now);
    const arond = {
      repo: 'Narcis13/arond', machineId: 'm-arond', checkout: join(dataDir, 'arond'), recipe: 'fabrica/porti/porti.json', worktree: join(dataDir, 'wt', '{id}'),
      portFrom: 5600, portTo: 5609, dbPrefix: 'arond_', migrationFrom: 40, migrationBlock: 10, cleanup: ['bash curata.sh {id}'],
    };
    old.setSetting('factory_repos', [arond]);
    const task = (id: string, repo: string | null, status = 'gata', integratedAt: number | null = null) =>
      old.run('INSERT INTO tasks (id, title, status, repo, created_at, updated_at, integrated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, `Task ${id}`, status, repo, now, now, integratedAt);
    task('P8a', 'narcis13/AROND'); // the repo spelled differently
    task('P7', 'Narcis13/arond', 'integrata', now - 3 * 3600_000);
    task('W1', 'acme/Web_Shop');
    task('W2', 'acme/web_shop', 'integrata', now - 1000);
    task('Z1', null);
    task('Z2', '  ');
    old.close();

    const s = await startTestServer({ dataDir });
    try {
      s.ctx.notify = () => {};
      const w = await s.login();
      const tok = createAgentToken(s.ctx, 'arond-coordinator').token;
      const a = async (tool: string, body: unknown = {}) => {
        const r = await fetch(`${s.url}/api/agent/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const j = (await r.json()) as { result?: any; error?: string };
        if (!r.ok) throw new Error(`${tool} ${r.status} ${j.error}`);
        return j.result;
      };

      const projects = await w.get('/api/factory/projects?state=all');
      expect(projects.map((p: any) => p.key)).toEqual(['arond', 'web-shop']);
      expect(projects[0]).toMatchObject({
        name: 'arond', repo: 'Narcis13/arond', idPrefix: '', machineId: 'm-arond', machineName: 'box', checkout: arond.checkout, lineFile: 'fabrica/porti/porti.json',
        state: 'active', autopilot: false, archivedAt: null, archived: 1, integrated: 1, counts: { gata: 1, integrata: 0 },
        config: { legacy: { worktree: arond.worktree, portFrom: 5600, portTo: 5609, dbPrefix: 'arond_', migrationFrom: 40, migrationBlock: 10, cleanup: arond.cleanup } },
      });
      expect(projects[1]).toMatchObject({ name: 'Web_Shop', repo: 'acme/Web_Shop', lineFile: 'factory.json', machineId: null, config: {}, archived: 1, counts: { gata: 1 } });

      const all = await w.get('/api/tasks?archived=all');
      const by = (id: string) => all.find((t: any) => t.id === id);
      expect(by('P8a')).toMatchObject({ project: 'arond', localId: 'P8a', archivedAt: null, stage: null });
      expect(by('P7')).toMatchObject({ project: 'arond', archivedAt: now - 3 * 3600_000 });
      expect(by('W1')).toMatchObject({ project: 'web-shop', archivedAt: null });
      expect(by('W2')).toMatchObject({ project: 'web-shop', archivedAt: now - 1000 });
      expect(by('Z1').project).toBeNull();
      expect(by('Z2').project).toBeNull();
      expect(ids(await a('tasks_list'))).toEqual(['P8a', 'W1', 'Z1', 'Z2']);
      expect(ids(await a('tasks_list', { archived: true }))).toEqual(['P7', 'W2']);

      // the Settings card reads the same config back
      expect(await w.get('/api/factory/config')).toEqual({ maxRounds: 3, repos: [arond] });

      // arond keeps working as before (§12.10): ids unchanged, resources, the recipe gate run, cleanup
      const claim = await a('tasks_claim', { id: 'P8a', force: true });
      expect(claim.resources).toEqual({ port: 5600, db: 'arond_p8a', migrations: { from: 40, to: 49 } });
      await a('tasks_update', { id: 'P8a', status: 'la_porti' });
      const run = await a('gates_run', { taskId: 'P8a', gate: 'G1' });
      expect(run).toMatchObject({ status: 'queued', machineId: 'm-arond', sent: false });
      const cmd = JSON.parse(s.ctx.db.get<{ command_json: string }>('SELECT command_json FROM gate_runs WHERE id = ?', run.runId)!.command_json);
      expect(cmd.run).toMatchObject({
        checkout: arond.checkout, recipe: 'fabrica/porti/porti.json',
        vars: { id: 'P8a', idLower: 'p8a', localId: 'P8a', project: 'arond', round: '1', port: '5600', db: 'arond_p8a', worktree: join(dataDir, 'wt', 'P8a') },
      });
      expect((await a('tasks_update', { id: 'P8a', status: 'integrata' })).cleanup).toEqual(['bash curata.sh P8a']);
      expect(await a('tasks_create', { id: 'P9', title: 'Next', repo: 'Narcis13/arond' })).toMatchObject({ id: 'P9', localId: 'P9', project: 'arond' });
    } finally {
      await s.stop();
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Windows may hold the WAL briefly
      }
    }
  });
});

describe('projects', () => {
  it('are created, read, changed and deleted by the owner, and read by agents', async () => {
    const ed = await web.post('/api/factory/projects', { key: 'ed', name: 'Editor', repo: 'acme/editor', idPrefix: 'ED-' });
    expect(ed).toMatchObject({
      key: 'ed', name: 'Editor', repo: 'acme/editor', idPrefix: 'ED-', machineId: null, machineName: null, checkout: null, lineFile: 'factory.json', config: {},
      resolvedLine: null, state: 'active', autopilot: false, archived: 0, integrated: 0, costUsd: 0, openDecisions: 0, attention: 0, lastActivityAt: null, checkoutIds: [],
      counts: { backlog: 0, gata: 0, in_lucru: 0, la_porti: 0, integrata: 0, blocata: 0 },
    });
    await expect(web.post('/api/factory/projects', { key: 'ed' })).rejects.toThrow(/409 .*project ed already exists/);
    await expect(web.post('/api/factory/projects', { key: 'ed2', repo: 'ACME/editor' })).rejects.toThrow(/409 .*repo ACME\/editor belongs to project ed/);
    await expect(web.post('/api/factory/projects', { key: 'ed3', idPrefix: 'ED-' })).rejects.toThrow(/409 .*id prefix ED- belongs to project ed/);
    await expect(web.post('/api/factory/projects', { key: 'Bad Key' })).rejects.toThrow(/400 .*key/);
    await expect(web.post('/api/factory/projects', { key: 'xy', idPrefix: 'ed-' })).rejects.toThrow(/400 .*idPrefix/);
    await expect(web.post('/api/factory/projects', { key: 'xy', machineId: 'nope' })).rejects.toThrow(/400 .*unknown machine nope/);

    // config merges key by key; null removes a key
    await web.put('/api/factory/projects/ed', { config: { limits: { workers: 3 }, models: { foreman: null } } });
    expect((await web.get('/api/factory/projects/ed')).config).toEqual({ limits: { workers: 3 }, models: { foreman: null } });
    const changed = await web.put('/api/factory/projects/ed', { name: 'Editor 2', config: { limits: null, integrate: { approval: 'always' } } });
    expect(changed).toMatchObject({ name: 'Editor 2', config: { models: { foreman: null }, integrate: { approval: 'always' } } });
    expect(changed.config.limits).toBeUndefined();
    await expect(web.put('/api/factory/projects/ed', { config: { limits: { workers: 0 } } })).rejects.toThrow(/400/);

    expect((await agent('projects_list')).map((p: any) => p.key)).toContain('ed');
    expect(await agent('projects_get', { key: 'ed' })).toMatchObject({ key: 'ed', line: [], next: [], decisions: [] });
    await expect(agent('projects_get', { key: 'nope' })).rejects.toThrow(/404 unknown project nope/);
    await expect(agent('projects_get', { key: 'Nope!' })).rejects.toThrow(/400/);

    // only a project without packages can be deleted
    await web.post('/api/factory/projects', { key: 'tmp-x' });
    expect(await web.del('/api/factory/projects/tmp-x')).toEqual({ ok: true });
    await expect(web.get('/api/factory/projects/tmp-x')).rejects.toThrow(/404/);
    const actions = srv.ctx.db.all<{ action: string; actor: string }>("SELECT action, actor FROM audit_log WHERE target IN ('ed', 'tmp-x') ORDER BY id");
    expect(actions.map((x) => x.action)).toEqual(['project_create', 'project_update', 'project_update', 'project_create', 'project_delete']);
    expect(new Set(actions.map((x) => x.actor))).toEqual(new Set(['web']));
  });

  it('pause, resume, autopilot and refresh', async () => {
    await web.post('/api/factory/projects', { key: 'states' });
    expect((await web.post('/api/factory/projects/states/pause')).state).toBe('paused');
    expect((await agent('projects_list')).find((p: any) => p.key === 'states').state).toBe('paused');
    expect((await agent('projects_list', { state: 'paused' })).map((p: any) => p.key)).toEqual(['states']);
    expect((await web.post('/api/factory/projects/states/resume')).state).toBe('active');
    expect((await web.post('/api/factory/projects/states/autopilot', { on: true })).autopilot).toBe(true);
    await expect(web.post('/api/factory/projects/states/autopilot', {})).rejects.toThrow(/400 .*on: true or false/);
    expect((await web.post('/api/factory/projects/states/autopilot', { on: false })).autopilot).toBe(false);
    expect(await web.post('/api/factory/projects/states/refresh')).toEqual({ sent: false, reason: expect.any(String) });
    await expect(web.post('/api/factory/projects/states/explode')).rejects.toThrow(/404/);
    // the whole segment names the action (Hono's trie router would take "archivex" for "archive")
    await expect(web.post('/api/factory/projects/states/archivex')).rejects.toThrow(/404/);
    await agent('tasks_create', { project: 'states', id: 'S1', title: 'Stays' });
    await expect(web.post('/api/tasks/S1/archivex')).rejects.toThrow(/404/);
    expect((await web.get('/api/factory/projects/states')).state).toBe('active');
    expect((await web.get('/api/tasks/S1')).archivedAt).toBeNull();
    await expect(web.get('/api/factory/projects?state=gone')).rejects.toThrow(/400/);
  });

  it('show their counts, cost, what waits on the owner, the line, the next packages and their checkouts', async () => {
    await web.post('/api/factory/projects', { key: 'view', repo: 'acme/viewer' });
    await agent('tasks_create', { project: 'view', id: 'V1', title: 'Blocked', status: 'blocata' });
    await agent('tasks_create', { project: 'view', id: 'V2', title: 'Asks', status: 'in_lucru' });
    await agent('tasks_create', { project: 'view', id: 'V3', title: 'Ready', status: 'gata' });
    await agent('tasks_update', { id: 'V1', costUsd: 1.5 });
    await agent('tasks_update', { id: 'V2', costUsd: 2.25 });
    await agent('decision_ask', { question: 'Which way?', taskId: 'V2' });
    const m = createMachine(srv.ctx, 'viewbox');
    const checkout = Number(srv.ctx.db.run("INSERT INTO projects (machine_id, root_path, name, gh_owner, gh_repo) VALUES (?, '/w/viewer', 'viewer', 'Acme', 'Viewer')", m.id).lastInsertRowid);
    const v = await agent('projects_get', { key: 'view' });
    expect(v).toMatchObject({
      counts: { backlog: 0, gata: 1, in_lucru: 1, la_porti: 0, integrata: 0, blocata: 1 }, costUsd: 3.75, openDecisions: 1, attention: 2, checkoutIds: [checkout],
      lastActivityAt: expect.any(Number),
    });
    expect(ids(v.line)).toEqual(['V2']);
    expect(ids(v.next)).toEqual(['V3']);
    expect(v.decisions.map((d: any) => d.question)).toEqual(['Which way?']);
    expect((await web.get('/api/factory/projects')).find((p: any) => p.key === 'view')).toMatchObject({ attention: 2, costUsd: 3.75 });
  });
});

describe('package ids', () => {
  it('get the project prefix, are numbered, and local dependencies resolve inside the project first', async () => {
    const p1 = await agent('tasks_create', { project: 'ed', id: 'P1', title: 'One', status: 'gata' });
    expect(p1).toMatchObject({ id: 'ED-P1', localId: 'P1', project: 'ed', repo: 'acme/editor', stage: null, archivedAt: null });
    expect((await agent('tasks_create', { project: 'ed', title: 'Numbered' })).id).toBe('ED-1');
    expect((await agent('tasks_create', { project: 'ed', id: 'ED-7', title: 'Seven' })).id).toBe('ED-7'); // already prefixed: kept
    expect((await agent('tasks_create', { project: 'ed', title: 'Numbered again' })).id).toBe('ED-8');
    await expect(agent('tasks_create', { project: 'ed', id: 'P1', title: 'Again' })).rejects.toThrow(/409 task ED-P1 already exists/);

    await agent('tasks_create', { id: 'P1', title: 'A global P1' });
    await agent('tasks_create', { id: 'Q1', title: 'Only global' });
    const p2 = await agent('tasks_create', { project: 'ed', id: 'P2', title: 'Two', dependsOn: ['P1', 'Q1'] });
    expect(p2).toMatchObject({ id: 'ED-P2', dependsOn: ['ED-P1', 'Q1'] });
    expect((await agent('tasks_update', { id: 'ED-P2', dependsOn: ['P1', 'ED-1'] })).dependsOn).toEqual(['ED-1', 'ED-P1']);

    // without a project: the project of the repo, else none
    expect(await agent('tasks_create', { repo: 'Acme/Editor', id: 'P4', title: 'By repo' })).toMatchObject({ id: 'ED-P4', project: 'ed' });
    expect(await agent('tasks_create', { repo: 'acme/elsewhere', id: 'E1', title: 'No project' })).toMatchObject({ id: 'E1', project: null });
    await expect(agent('tasks_create', { project: 'nope', title: 'x' })).rejects.toThrow(/404 unknown project nope/);
    // the web form passes the project too
    expect(await web.post('/api/tasks', { project: 'ed', id: 'W1', title: 'From the PWA' })).toMatchObject({ id: 'ED-W1', localId: 'W1' });

    // a package keeps its project for life; one without a project joins the one an upsert names
    await web.post('/api/factory/projects', { key: 'other' });
    await expect(agent('tasks_create', { project: 'other', id: 'ED-P1', title: 'Moved?', upsert: true })).rejects.toThrow(/409 task ED-P1 belongs to project ed/);
    expect(await agent('tasks_create', { project: 'other', id: 'E1', title: 'Adopted', upsert: true })).toMatchObject({ id: 'E1', project: 'other', title: 'Adopted' });
    expect((await agent('tasks_get', { id: 'E1' })).events[0]).toMatchObject({ kind: 'update', detail: { title: 'Adopted', project: 'other' } });
  });

  it('come from Markdown imports into a project, from the web and from bb tasks import --project', async () => {
    const files = [
      { name: 'p6.md', text: '---\nid: P6\ntitle: Six\ndepends_on: [P5]\n---\n' },
      { name: 'p5.md', text: '---\nid: P5\ntitle: Five\ndepends_on: [P1]\n---\n' },
      { name: 'noid.md', text: '---\ntitle: No id\n---\n' },
    ];
    const first = await web.post('/api/tasks/import/markdown', { files, project: 'ed' });
    expect(first.imported).toEqual(['ED-P5', 'ED-P6', 'ED-9']);
    expect((await web.get('/api/tasks/ED-P6')).dependsOn).toEqual(['ED-P5']);
    expect((await web.get('/api/tasks/ED-P5')).dependsOn).toEqual(['ED-P1']);
    expect((await web.post('/api/tasks/import/markdown', { files, project: 'ed' })).imported).toEqual(first.imported); // upserts, by path without an id
    await expect(web.post('/api/tasks/import/markdown', { files: [{ name: 'x.md', text: '---\nid: X\ntitle: X\nproject: other\n---\n' }], project: 'ed' })).rejects.toThrow(
      /400 .*x\.md: project other, but the import is into ed/,
    );
    expect((await web.post('/api/tasks/import/markdown', { files: [{ name: 'y.md', text: '---\nid: Y1\ntitle: Y\nproject: ed\n---\n' }] })).imported).toEqual(['ED-Y1']);

    const dir = join(tmp, 'packages');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'p10.md'), '---\nid: P10\ntitle: Ten\ndepends_on: [P6]\n---\n');
    process.env.BUILDYBOY_URL = srv.url;
    process.env.BUILDYBOY_AGENT_TOKEN = token;
    const log = console.log;
    const out: string[] = [];
    console.log = (s: string) => void out.push(s);
    try {
      expect(await tasksCli(['import', dir, '--project', 'ed'])).toBe(0);
    } finally {
      console.log = log;
      delete process.env.BUILDYBOY_URL;
      delete process.env.BUILDYBOY_AGENT_TOKEN;
    }
    expect(out).toEqual(['ED-P10\tbacklog\tTen']);
    expect(await web.get('/api/tasks/ED-P10')).toMatchObject({ project: 'ed', dependsOn: ['ED-P6'], source: 'agent' });
  });
});

describe('claiming', () => {
  it('picks across active projects, never in a paused or archived one, and packages without a project stay claimable', async () => {
    await web.post('/api/factory/projects', { key: 'alpha' });
    await web.post('/api/factory/projects', { key: 'beta' });
    await agent('tasks_create', { project: 'alpha', id: 'A1', title: 'Alpha', status: 'gata', priority: 800 });
    await agent('tasks_create', { project: 'beta', id: 'B1', title: 'Beta', status: 'gata', priority: 900 });
    await agent('tasks_create', { id: 'L1', title: 'Loose', status: 'gata', priority: 700 });

    await web.post('/api/factory/projects/beta/pause');
    expect((await agent('tasks_claim', { force: true })).task.id).toBe('A1'); // B1 is first by priority, but paused
    expect(await agent('tasks_claim', { id: 'B1', force: true })).toMatchObject({ task: null, reason: 'project beta is paused' });
    expect(await agent('tasks_claim', { project: 'beta', force: true })).toMatchObject({ task: null, reason: 'project beta is paused' });
    expect(await agent('tasks_claim', { project: 'alpha', force: true })).toMatchObject({ task: null, reason: 'no task of project alpha is ready to start' });
    expect(await agent('tasks_claim', { id: 'L1', project: 'alpha', force: true })).toMatchObject({ task: null, reason: 'task L1 is not in project alpha' });
    await expect(agent('tasks_claim', { project: 'nope', force: true })).rejects.toThrow(/404 unknown project nope/);
    await web.post('/api/factory/projects/beta/resume');
    expect((await agent('tasks_claim', { project: 'beta', force: true })).task).toMatchObject({ id: 'B1', status: 'in_lucru', project: 'beta' });
    expect((await agent('tasks_claim', { id: 'L1', force: true })).task).toMatchObject({ id: 'L1', status: 'in_lucru', project: null });

    // an archived project: its packages are archived, nothing is claimed or created in it
    await agent('tasks_create', { project: 'beta', id: 'B2', title: 'Beta two', status: 'gata' });
    await web.post('/api/factory/projects/beta/archive');
    expect(await agent('tasks_claim', { id: 'B2', force: true })).toMatchObject({ task: null, reason: 'task B2 is archived' });
    await expect(agent('tasks_create', { project: 'beta', title: 'Late' })).rejects.toThrow(/409 project beta is archived/);

    // no launch in a paused project
    await agent('tasks_create', { project: 'alpha', id: 'A2', title: 'Alpha two', status: 'gata' });
    await web.post('/api/factory/projects/alpha/pause');
    await expect(web.post('/api/tasks/A2/launch', { machineId: 'any', cwd: tmp })).rejects.toThrow(/409 .*project alpha is paused/);
    await web.post('/api/factory/projects/alpha/resume');
  });
});

describe('the archive', () => {
  it('archives and unarchives packages, leaves them out of lists, and sweeps integrated ones after archive_done_after_hours', async () => {
    await web.post('/api/factory/projects', { key: 'arc' });
    for (const id of ['R1', 'R2']) {
      await agent('tasks_create', { project: 'arc', id, title: id, status: 'gata' });
      await agent('tasks_update', { id, status: 'integrata' });
    }
    await agent('tasks_create', { project: 'arc', id: 'R3', title: 'Needs R1', status: 'gata', dependsOn: ['R1'] });

    // the owner or an operator archives
    await expect(agent('tasks_update', { id: 'R2', archived: true })).rejects.toThrow(/403 only the owner or an operator/);
    expect((await op('tasks_update', { id: 'R2', archived: true })).archivedAt).toEqual(expect.any(Number));
    expect((await agent('tasks_get', { id: 'R2' })).events[0]).toMatchObject({ kind: 'archived', actor: 'agent:operator' });
    expect(ids(await agent('tasks_list', { project: 'arc' }))).toEqual(['R1', 'R3']);
    expect(ids(await agent('tasks_list', { project: 'arc', archived: true }))).toEqual(['R2']);
    expect(ids(await web.get('/api/tasks?project=arc&archived=1'))).toEqual(['R2']);
    expect(ids(await web.get('/api/tasks?project=arc&archived=all'))).toEqual(['R1', 'R2', 'R3']);
    expect((await web.post('/api/tasks/R2/unarchive')).archivedAt).toBeNull();
    expect((await web.post('/api/tasks/R2/archive')).archivedAt).toEqual(expect.any(Number));
    expect((await web.put('/api/tasks/R2', { archived: false })).archivedAt).toBeNull();
    expect((await agent('tasks_get', { id: 'R2' })).events.slice(0, 3).map((e: any) => `${e.kind}:${e.actor}`)).toEqual(['unarchived:web', 'archived:web', 'unarchived:web']);

    // the sweep: integrated more than 24 h ago (the default)
    srv.ctx.db.run('UPDATE tasks SET integrated_at = ? WHERE id = ?', Date.now() - 25 * 3600_000, 'R1');
    srv.ctx.db.run('UPDATE tasks SET integrated_at = ? WHERE id = ?', Date.now() - 2 * 3600_000, 'R2');
    expect(archiveSweep(srv.ctx)).toEqual(['R1']);
    expect((await agent('tasks_get', { id: 'R1' })).events[0]).toMatchObject({ kind: 'archived', actor: 'factory:archive', detail: { afterHours: 24 } });
    // an archived dependency still counts as integrated
    expect(ids(await agent('tasks_list', { project: 'arc', ready: true }))).toEqual(['R3']);
    await web.put('/api/settings', { archive_done_after_hours: 0 });
    expect(archiveSweep(srv.ctx)).toEqual([]);
    await web.put('/api/settings', { archive_done_after_hours: 1 });
    expect(archiveSweep(srv.ctx)).toEqual(['R2']);
    expect((await web.get('/api/settings')).archive_done_after_hours).toBe(1);
    await web.put('/api/settings', { archive_done_after_hours: null });

    // "Archive done" on the project
    await agent('tasks_create', { project: 'arc', id: 'R4', title: 'R4', status: 'gata' });
    await agent('tasks_update', { id: 'R4', status: 'integrata' });
    expect(await web.post('/api/factory/projects/arc/archive-done')).toEqual({ archived: ['R4'] });

    // archiving the project archives the rest with its own timestamp; unarchiving brings back exactly those
    const r1 = (await web.get('/api/tasks/R1')).archivedAt;
    const archived = await web.post('/api/factory/projects/arc/archive');
    expect(archived).toMatchObject({ state: 'archived', archivedAt: expect.any(Number), counts: { gata: 0 }, archived: 4 });
    expect((await web.get('/api/tasks/R3')).archivedAt).toBe(archived.archivedAt);
    expect((await web.get('/api/factory/projects')).map((p: any) => p.key)).not.toContain('arc');
    expect((await web.get('/api/factory/projects?state=archived')).map((p: any) => p.key)).toContain('arc');
    await expect(web.post('/api/tasks/R3/unarchive')).rejects.toThrow(/409 .*unarchive the project first/);
    await expect(web.post('/api/factory/projects/arc/pause')).rejects.toThrow(/409/);
    await expect(web.post('/api/factory/projects/arc/autopilot', { on: true })).rejects.toThrow(/409/);
    expect((await web.post('/api/factory/projects/arc/unarchive')).state).toBe('active');
    expect((await web.get('/api/tasks/R3')).archivedAt).toBeNull();
    expect((await web.get('/api/tasks/R1')).archivedAt).toBe(r1);
    await expect(web.del('/api/factory/projects/arc')).rejects.toThrow(/409 .*4 packages: archive it instead/);
  });
});

describe('the /api/factory/config shim', () => {
  it('reads and writes §11.7 repo configs on the projects', async () => {
    const entry = {
      repo: 'Acme/Shop', machineId: null, checkout: 'C:/work/shop', recipe: 'gates/recipe.json', worktree: 'C:/wt/{localIdLower}', portFrom: 4100, portTo: 4101,
      dbPrefix: 'shop_', migrationFrom: 30, migrationBlock: 10, cleanup: ['drop {db}'],
    };
    expect(await web.put('/api/factory/config', { maxRounds: 4, repos: [entry] })).toEqual({ maxRounds: 4, repos: [entry] });
    expect(await web.get('/api/factory/projects/shop')).toMatchObject({
      repo: 'Acme/Shop', checkout: 'C:/work/shop', lineFile: 'gates/recipe.json', config: { legacy: { portFrom: 4100, dbPrefix: 'shop_', cleanup: ['drop {db}'] } },
    });
    expect((await agent('tasks_get', { id: (await agent('tasks_create', { repo: 'acme/shop', title: 'Shop work' })).id })).maxRounds).toBe(4);

    // a repo that already has a project is written onto it; a missing recipe means the default line file
    await web.post('/api/factory/projects', { key: 'edx', repo: 'acme/edx', idPrefix: 'EX-' });
    const both = await web.put('/api/factory/config', { maxRounds: 3, repos: [entry, { repo: 'ACME/EDX', portFrom: 4200 }] });
    expect(both.repos[1]).toMatchObject({ repo: 'acme/edx', recipe: 'factory.json', portFrom: 4200, portTo: null, migrationBlock: 10, cleanup: [] });
    expect(await web.get('/api/factory/projects/edx')).toMatchObject({ idPrefix: 'EX-', config: { legacy: { portFrom: 4200 } } });

    // a repo left out loses its legacy fields, not its project
    expect(await web.put('/api/factory/config', { maxRounds: 3, repos: [entry] })).toEqual({ maxRounds: 3, repos: [entry] });
    expect((await web.get('/api/factory/projects/edx')).config).toEqual({});
    await web.put('/api/factory/config', { maxRounds: 3, repos: [] });
    expect(await web.get('/api/factory/config')).toEqual({ maxRounds: 3, repos: [] });
    expect((await web.get('/api/factory/projects/shop')).state).toBe('active');
    await expect(web.put('/api/factory/config', { maxRounds: 3, repos: [entry, { ...entry, repo: 'acme/SHOP' }] })).rejects.toThrow(/400 .*each repo can be configured once/);
    await expect(web.put('/api/factory/config', { maxRounds: 3, repos: [{ ...entry, dbPrefix: 'bad prefix!' }] })).rejects.toThrow(/400 .*dbPrefix/);
  });
});

describe('resources and gate runs through a project', () => {
  it('allocate from the project, run the gate from its machine, checkout and line file, and fill every placeholder', async () => {
    const m = createMachine(srv.ctx, 'runbox');
    await web.post('/api/factory/projects', {
      key: 'res', repo: 'acme/res', idPrefix: 'RS-', machineId: m.id, checkout: 'C:/work/res', lineFile: 'factory/gates.json',
      config: {
        legacy: {
          worktree: 'C:/wt/{project}/{localIdLower}', portFrom: 4500, portTo: 4501, dbPrefix: 'res_', migrationFrom: 100, migrationBlock: 5,
          cleanup: ['rm {worktree}', 'git branch -D {branch}', 'drop {db} {localId} {project} {idLower} {unknown}'],
        },
      },
    });
    await agent('tasks_create', { project: 'res', id: 'P1', title: 'One', status: 'gata' });
    await agent('tasks_create', { project: 'res', id: 'P2', title: 'Two', status: 'gata' });
    expect((await agent('tasks_claim', { id: 'RS-P1', force: true })).resources).toEqual({ port: 4500, db: 'res_rs_p1', migrations: { from: 100, to: 104 } });
    expect((await agent('tasks_claim', { id: 'RS-P2', force: true })).resources).toEqual({ port: 4501, db: 'res_rs_p2', migrations: { from: 105, to: 109 } });

    await agent('tasks_update', { id: 'RS-P1', branch: 'pkg/RS-P1', status: 'la_porti' });
    const run = await agent('gates_run', { taskId: 'RS-P1', gate: 'G1' });
    expect(run).toMatchObject({ status: 'queued', round: 1, machineId: m.id, sent: false });
    const cmd = JSON.parse(srv.ctx.db.get<{ command_json: string }>('SELECT command_json FROM gate_runs WHERE id = ?', run.runId)!.command_json);
    expect(cmd.run).toMatchObject({
      taskId: 'RS-P1', checkout: 'C:/work/res', recipe: 'factory/gates.json',
      vars: { id: 'RS-P1', idLower: 'rs-p1', localId: 'P1', localIdLower: 'p1', project: 'res', round: '1', port: '4500', db: 'res_rs_p1', branch: 'pkg/RS-P1', worktree: 'C:/wt/res/p1' },
    });
    expect((await agent('tasks_update', { id: 'RS-P1', status: 'integrata' })).cleanup).toEqual(['rm C:/wt/res/p1', 'git branch -D pkg/RS-P1', 'drop res_rs_p1 P1 res rs-p1 {unknown}']);

    await web.put('/api/factory/projects/res', { machineId: null });
    await expect(agent('gates_run', { taskId: 'RS-P2', gate: 'G1' })).rejects.toThrow(/400 project res: it needs a machine/);
    await agent('tasks_create', { id: 'NOPROJ', title: 'Loose' });
    await expect(agent('gates_run', { taskId: 'NOPROJ', gate: 'G1' })).rejects.toThrow(/400 NOPROJ belongs to no factory project/);
  });
});

describe('the digest', () => {
  const base: DigestData = {
    since: 0,
    integrated: [{ id: 'P1', title: 'One', sensitive: false }, { id: 'ED-2', title: 'Two', sensitive: true }],
    gates: { pass: 0, fail: 1, skip: 0, failed: [{ taskId: 'ED-2', gate: 'G3' }] },
    blocked: [],
    inProgress: ['P3', 'ED-4', 'T9'],
    decisionsPending: 1,
    decisions: [{ id: 'd', taskId: 'ED-4', question: 'Which way?', ageMs: 120_000 }],
    warnings: [{ taskId: 'P3', message: 'renumber' }],
    controlsOpen: 0,
    usage: { fiveHourPct: 10, sevenDayPct: 20, canStart: true, stopAll: false, reason: 'ok' },
    note: null,
  };

  it('names the project on each line once packages of more than one project appear', async () => {
    const two = digestText({ ...base, projects: { P1: 'arond', P3: 'arond', 'ED-2': 'ed', 'ED-4': 'ed' } }).body.split('\n');
    expect(two).toEqual([
      'Integrated: arond: P1; ed: ED-2 (sensitive)',
      'Gates: 0 passed, 1 failed (ed: ED-2 G3)',
      'In progress: arond: P3; ed: ED-4; T9',
      'Usage: 5 h 10%, 7 d 20%',
      'Warning arond P3: renumber',
      'Decisions waiting: 1',
      '  · ed ED-4, 2 min: Which way?',
    ]);
    // one project (or none): as before
    const one = digestText({ ...base, projects: { P1: 'arond', P3: 'arond' } }).body;
    expect(one).toContain('Integrated: P1, ED-2 (sensitive)');
    expect(one).toContain('Warning P3: renumber');
    expect(digestText(base).body).toContain('In progress: P3, ED-4, T9');

    // end to end: packages integrated today in two projects
    await web.post('/api/factory/projects', { key: 'dig-a' });
    await web.post('/api/factory/projects', { key: 'dig-b' });
    for (const [project, id] of [['dig-a', 'DA1'], ['dig-b', 'DB1']]) {
      await agent('tasks_create', { project, id, title: id, status: 'gata' });
      await agent('tasks_update', { id, status: 'integrata' });
    }
    const body = (await agent('digest_post', {})).body as string;
    expect(body).toMatch(/^Integrated: .*dig-a: DA1/m);
    expect(body).toMatch(/^Integrated: .*dig-b: DB1/m);
  });
});

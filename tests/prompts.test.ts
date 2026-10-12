import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, TEST_PASSWORD, type TestServer, type WebClient } from './helpers.ts';
import { search } from '../server/search.ts';
import type { PromptVersion, PromptView, TemplateDetail, TemplateInfo, Values } from '../shared/harness.ts';

const repo = join(import.meta.dirname, '..');
let root: string;
let srv: TestServer;
let web: WebClient;
let harnessId: number;

const slots = (over: Values = {}): Values => ({
  Goal: 'Add rate limiting', 'Done when': '`npm test` passes', Scope: 'server/', Limit: '2 hours', Subagents: '3', Branch: 'new', 'Branch.name': 'feat/rl', PR: 'yes', Unattended: 'no', ...over,
});

/** Cookie + CSRF headers for raw requests (the WebClient has no DELETE). */
async function authHeaders() {
  const res = await fetch(`${srv.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: TEST_PASSWORD }) });
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  const csrf = cookies.find((c) => c.startsWith('bb_csrf='))!.slice('bb_csrf='.length);
  return { cookie: cookies.join('; '), 'x-bb-csrf': csrf };
}

beforeAll(async () => {
  // a private copy of the repo root so the test can edit the template file
  root = mkdtempSync(join(tmpdir(), 'bb-prompts-root-'));
  copyFileSync(join(repo, 'harness-prompt.md'), join(root, 'harness-prompt.md'));
  srv = await startTestServer({ rootDir: root });
  web = await srv.login();
  harnessId = (await web.get<TemplateInfo[]>('/api/templates')).find((t) => t.name === 'harness')!.id;
});
afterAll(async () => {
  await srv.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('auth', () => {
  it('requires a web session on every route', async () => {
    for (const [method, path] of [['GET', '/api/templates'], ['POST', '/api/templates'], ['GET', '/api/prompts'], ['POST', '/api/prompts'], ['GET', '/api/prompts/1'], ['PUT', '/api/prompts/1'], ['DELETE', '/api/prompts/1'], ['GET', '/api/prompts/1/versions']]) {
      const res = await fetch(`${srv.url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('templates', () => {
  it('seeds the harness template from harness-prompt.md with parsed slots', async () => {
    const list = await web.get<TemplateInfo[]>('/api/templates');
    expect(list[0]).toMatchObject({ name: 'harness', source: join(root, 'harness-prompt.md') });
    const t = await web.get<TemplateDetail>(`/api/templates/${harnessId}`);
    expect(t.body).toBe(readFileSync(join(root, 'harness-prompt.md'), 'utf8'));
    expect(t.parsed.mode).toBe('harness');
    expect(t.parsed.slots.map((s) => s.key)).toEqual(['Goal', 'Done when', 'Scope', 'Limit', 'Subagents', 'Branch', 'PR', 'Unattended']);
  });

  it('shows edits to the file without a restart', async () => {
    const path = join(root, 'harness-prompt.md');
    const orig = readFileSync(path, 'utf8');
    try {
      writeFileSync(path, orig.replace('Unattended: <yes | no>', 'Unattended: <yes | no>\r\nExtra: <anything else>'));
      const t = await web.get<TemplateDetail>(`/api/templates/${harnessId}`);
      expect(t.parsed.slots.map((s) => s.key)).toContain('Extra');
    } finally {
      writeFileSync(path, orig);
    }
    const back = await web.get<TemplateDetail>(`/api/templates/${harnessId}`);
    expect(back.parsed.slots).toHaveLength(8);
  });

  it('accepts uploaded templates and turns every <placeholder> into a slot', async () => {
    const t = await web.post<TemplateDetail>('/api/templates', { name: 'bugfix', body: 'Fix <the bug> in <module>.\n' });
    expect(t.parsed.mode).toBe('generic');
    expect(t.parsed.slots.map((s) => s.key)).toEqual(['the bug', 'module']);
    expect((await web.get<TemplateInfo[]>('/api/templates')).map((x) => x.name)).toEqual(['harness', 'bugfix']);
    const p = await web.post<PromptView>('/api/prompts', { templateId: t.id, title: 'bugfix', slots: { 'the bug': 'crash', module: 'auth' }, extraMd: '', tags: [] });
    expect(p.rendered).toBe('Fix crash in auth.\n');
    await expect(web.post('/api/templates', { name: 'harness', body: 'x <y>' })).rejects.toThrow(/409/);
    await expect(web.post('/api/templates', { name: 'plain', body: 'no placeholders' })).rejects.toThrow(/400/);
    await expect(web.post('/api/templates', { name: '', body: 'x <y>' })).rejects.toThrow(/400/);
  });
});

describe('prompts', () => {
  let id: number;

  it('creates a prompt, rendering it with the shared renderer', async () => {
    const p = await web.post<PromptView>('/api/prompts', { templateId: harnessId, title: 'Rate limiting', slots: slots(), extraMd: 'Spec text', tags: ['Backend', 'auth', 'backend'] });
    id = p.id;
    expect(p).toMatchObject({ title: 'Rate limiting', templateName: 'harness', version: 1, tags: ['backend', 'auth'] });
    expect(p.rendered).toContain('Goal: Add rate limiting');
    expect(p.rendered).toContain('Branch: new, `feat/rl`');
    expect(p.rendered).toContain('Done when: `npm test` passes');
    expect(p.rendered).toMatch(/## Spec\r?\n\r?\nSpec text\r?\n$/);
    expect(p.rendered).not.toMatch(/Goal: </);
    expect(p.stats).toMatchObject({ runs: 0, successRate: null });
    expect(await web.get<PromptView>(`/api/prompts/${id}`)).toEqual(p);
  });

  it('indexes the rendered prompt in full-text search', () => {
    expect(search(srv.ctx.db, 'rate limiting').filter((h) => h.kind === 'prompt').map((h) => h.ref)).toContain(`prompt-${id}`);
  });

  it('each save adds a version and updates the rendered text and the index', async () => {
    const p = await web.put<PromptView>(`/api/prompts/${id}`, { slots: slots({ Goal: 'Throttle sign-ins' }), tags: ['auth'] });
    expect(p).toMatchObject({ version: 2, tags: ['auth'] });
    expect(p.rendered).toContain('Goal: Throttle sign-ins');
    const again = await web.put<PromptView>(`/api/prompts/${id}`, { title: 'Throttle' });
    expect(again).toMatchObject({ version: 3, title: 'Throttle' });
    expect(again.slots.Goal).toBe('Throttle sign-ins');
    const versions = await web.get<PromptVersion[]>(`/api/prompts/${id}/versions`);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions[2].rendered).toContain('Goal: Add rate limiting');
    expect(versions[1].slots.Goal).toBe('Throttle sign-ins');
    expect(search(srv.ctx.db, 'sign-ins').filter((h) => h.ref === `prompt-${id}`)).toHaveLength(1);
    expect(search(srv.ctx.db, 'limiting').filter((h) => h.ref === `prompt-${id}`)).toHaveLength(0);
  });

  it('lists with search and tag filters', async () => {
    const other = await web.post<PromptView>('/api/prompts', { templateId: harnessId, title: 'Docs sweep', slots: slots({ Goal: 'Fix the docs' }), extraMd: '', tags: ['docs'] });
    expect((await web.get<PromptView[]>('/api/prompts')).map((p) => p.id)).toEqual(expect.arrayContaining([id, other.id]));
    expect((await web.get<PromptView[]>('/api/prompts?q=docs')).map((p) => p.id)).toEqual([other.id]);
    expect((await web.get<PromptView[]>('/api/prompts?q=sign-ins')).map((p) => p.id)).toEqual([id]);
    expect((await web.get<PromptView[]>('/api/prompts?tag=auth')).map((p) => p.id)).toEqual([id]);
    expect((await web.get<PromptView[]>('/api/prompts?tag=aut')).map((p) => p.id)).toEqual([]);
    expect((await web.get<PromptView[]>('/api/prompts?q=100%25_')).map((p) => p.id)).toEqual([]);
  });

  it('duplicates a prompt as a new prompt at version 1', async () => {
    const d = await web.post<PromptView>(`/api/prompts/${id}/duplicate`);
    expect(d).toMatchObject({ title: 'Throttle (copy)', version: 1, tags: ['auth'] });
    expect(d.id).not.toBe(id);
    expect(d.rendered).toBe((await web.get<PromptView>(`/api/prompts/${id}`)).rendered);
  });

  it('computes stats from jobs', async () => {
    const db = srv.ctx.db;
    const job = (n: number, status: string, cost: number | null, start: number | null, end: number | null) =>
      db.run('INSERT INTO jobs (id, prompt_id, machine_id, cwd, prompt_text, options_json, status, cost_usd, created_at, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', `job-${id}-${n}`, id, 'm', '/x', 'p', '{}', status, cost, 1, start, end);
    job(1, 'succeeded', 1, 1000, 61_000);
    job(2, 'succeeded', 3, 0, 120_000);
    job(3, 'failed', 2, 0, 30_000);
    job(4, 'running', null, 5, null);
    const p = await web.get<PromptView>(`/api/prompts/${id}`);
    expect(p.stats).toMatchObject({ runs: 4, finished: 3, succeeded: 2, avgDurationMs: 70_000 });
    expect(p.stats.successRate).toBeCloseTo(2 / 3);
    expect(p.stats.avgCostUsd).toBeCloseTo(2);
    expect((await web.get<PromptView[]>('/api/prompts')).find((x) => x.id === id)!.stats.runs).toBe(4);
  });

  it('deletes a prompt with its versions and index entry, and audits changes', async () => {
    const headers = await authHeaders();
    expect((await fetch(`${srv.url}/api/prompts/${id}`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await fetch(`${srv.url}/api/prompts/${id}`, { headers })).status).toBe(404);
    expect(srv.ctx.db.get('SELECT 1 AS x FROM prompt_versions WHERE prompt_id = ?', id)).toBeUndefined();
    expect(search(srv.ctx.db, 'sign-ins').filter((h) => h.ref === `prompt-${id}`)).toHaveLength(0);
    const actions = srv.ctx.db.all<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'prompt_%' OR action LIKE 'template_%'").map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['prompt_create', 'prompt_update', 'prompt_duplicate', 'prompt_delete', 'template_save']));
  });

  it('validates input', async () => {
    await expect(web.post('/api/prompts', { templateId: harnessId, title: '', slots: {}, extraMd: '' })).rejects.toThrow(/400/);
    await expect(web.post('/api/prompts', { templateId: 9999, title: 't', slots: {}, extraMd: '' })).rejects.toThrow(/400/);
    await expect(web.get('/api/prompts/9999')).rejects.toThrow(/404/);
    await expect(web.put('/api/prompts/9999', { title: 'x' })).rejects.toThrow(/404/);
  });
});

import { Hono } from 'hono';
import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { requireWeb } from '../auth.ts';
import { indexText } from '../search.ts';
import { parseTemplate, renderTemplate, type PromptStats, type PromptVersion, type PromptView, type TemplateDetail, type TemplateInfo, type Values } from '../../shared/harness.ts';

const HARNESS = 'harness';
const slotsSchema = z.record(z.string().max(200), z.string().max(50_000));
const tagsSchema = z.array(z.string().max(40)).max(20);
const promptSchema = z.object({
  templateId: z.number().int().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  slots: slotsSchema.optional(),
  extraMd: z.string().max(200_000).optional(),
  tags: tagsSchema.optional(),
});
const templateSchema = z.object({ name: z.string().trim().min(1).max(80), body: z.string().min(1).max(200_000) });

interface TemplateRow { id: number; name: string; source: string; body: string; updated_at: number }
interface PromptRow { id: number; template_id: number | null; title: string; slots_json: string; extra_md: string; rendered: string; tags: string; created_at: number; updated_at: number; template_name: string | null; version: number | null }
interface StatRow { prompt_id: number; runs: number; ok: number; finished: number; avg_cost: number | null; avg_dur: number | null }

const cleanTags = (tags: string[]) => [...new Set(tags.map((t) => t.toLowerCase().replace(/[\s,]+/g, '-').replace(/^-+|-+$/g, '')).filter(Boolean))];
const noStats = (): PromptStats => ({ runs: 0, finished: 0, succeeded: 0, successRate: null, avgCostUsd: null, avgDurationMs: null });

export function promptsRoutes(ctx: Ctx) {
  const app = new Hono();
  const auth = requireWeb(ctx);
  const { db } = ctx;
  const harnessPath = join(ctx.config.rootDir, 'harness-prompt.md');
  let seen = '';

  /** Seeds / refreshes the "harness" template from harness-prompt.md; cheap (one stat) when unchanged. */
  function syncHarness() {
    let st;
    try {
      st = statSync(harnessPath);
    } catch {
      return; // file missing: keep whatever copy the DB has
    }
    const stamp = `${st.mtimeMs}:${st.size}`;
    const row = db.get<TemplateRow>('SELECT * FROM templates WHERE name = ?', HARNESS);
    if (stamp === seen && row) return;
    const body = readFileSync(harnessPath, 'utf8');
    if (!row) db.run('INSERT INTO templates (name, source, body, updated_at) VALUES (?, ?, ?, ?)', HARNESS, harnessPath, body, Date.now());
    else if (row.body !== body || row.source !== harnessPath) db.run('UPDATE templates SET body = ?, source = ?, updated_at = ? WHERE id = ?', body, harnessPath, Date.now(), row.id);
    seen = stamp;
  }

  const info = (r: TemplateRow): TemplateInfo => ({ id: r.id, name: r.name, source: r.source, updatedAt: r.updated_at });
  const detail = (r: TemplateRow): TemplateDetail => ({ ...info(r), body: r.body, parsed: parseTemplate(r.body) });

  function statsFor(ids?: number[]): Map<number, PromptStats> {
    const rows = db.all<StatRow>(
      `SELECT prompt_id, COUNT(*) AS runs,
              SUM(status = 'succeeded') AS ok,
              SUM(status IN ('succeeded','failed','stopped','lost')) AS finished,
              AVG(cost_usd) AS avg_cost,
              AVG(CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL THEN ended_at - started_at END) AS avg_dur
       FROM jobs WHERE prompt_id IS NOT NULL ${ids ? `AND prompt_id IN (${ids.map(() => '?').join(',')})` : ''} GROUP BY prompt_id`,
      ...(ids ?? []),
    );
    return new Map(rows.map((r) => [r.prompt_id, { runs: r.runs, finished: r.finished, succeeded: r.ok, successRate: r.finished ? r.ok / r.finished : null, avgCostUsd: r.avg_cost, avgDurationMs: r.avg_dur }]));
  }

  const SELECT = `SELECT p.*, t.name AS template_name, (SELECT MAX(version) FROM prompt_versions v WHERE v.prompt_id = p.id) AS version
                  FROM prompts p LEFT JOIN templates t ON t.id = p.template_id`;
  const view = (r: PromptRow, stats: PromptStats): PromptView => ({
    id: r.id, templateId: r.template_id, templateName: r.template_name, title: r.title, slots: json<Values>(r.slots_json, {}) ?? {}, extraMd: r.extra_md,
    rendered: r.rendered, tags: r.tags ? r.tags.split(',') : [], version: r.version ?? 1, createdAt: r.created_at, updatedAt: r.updated_at, stats,
  });
  const load = (id: number) => {
    const r = db.get<PromptRow>(`${SELECT} WHERE p.id = ?`, id);
    return r ? view(r, statsFor([id]).get(id) ?? noStats()) : null;
  };

  function render(templateId: number | null | undefined, slots: Values, extraMd: string): { templateId: number; rendered: string } | null {
    if (templateId == null) return null;
    syncHarness();
    const t = db.get<TemplateRow>('SELECT * FROM templates WHERE id = ?', templateId);
    return t ? { templateId: t.id, rendered: renderTemplate(parseTemplate(t.body), slots, extraMd) } : null;
  }

  const reindex = (id: number, title: string, rendered: string) => {
    db.run("DELETE FROM search_index WHERE kind = 'prompt' AND ref = ?", `prompt-${id}`);
    indexText(db, 'prompt', `prompt-${id}`, null, `${title}\n${rendered}`);
  };

  function create(templateId: number, title: string, slots: Values, extraMd: string, tags: string[]): number {
    const r = render(templateId, slots, extraMd)!;
    return db.tx(() => {
      const now = Date.now();
      const { lastInsertRowid } = db.run(
        'INSERT INTO prompts (template_id, title, slots_json, extra_md, rendered, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        r.templateId, title, JSON.stringify(slots), extraMd, r.rendered, cleanTags(tags).join(','), now, now,
      );
      const id = Number(lastInsertRowid);
      db.run('INSERT INTO prompt_versions (prompt_id, version, slots_json, extra_md, rendered, created_at) VALUES (?, 1, ?, ?, ?, ?)', id, JSON.stringify(slots), extraMd, r.rendered, now);
      reindex(id, title, r.rendered);
      return id;
    });
  }

  // ---------- templates ----------

  app.get('/api/templates', auth, (c) => {
    syncHarness();
    return c.json(db.all<TemplateRow>('SELECT * FROM templates ORDER BY (name = ?) DESC, name', HARNESS).map(info));
  });

  app.post('/api/templates', auth, async (c) => {
    const p = templateSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: 'name and body are required' }, 400);
    const { name, body } = p.data;
    if (name.toLowerCase() === HARNESS) return c.json({ error: `"${HARNESS}" is the built-in template (edit harness-prompt.md instead)` }, 409);
    if (!parseTemplate(body).slots.length) return c.json({ error: 'no <placeholder> found in the template' }, 400);
    db.run('INSERT INTO templates (name, source, body, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at', name, 'upload', body, Date.now());
    const row = db.get<TemplateRow>('SELECT * FROM templates WHERE name = ?', name)!;
    db.audit('web', 'template_save', String(row.id), { name, bytes: body.length });
    return c.json(detail(row), 201);
  });

  app.get('/api/templates/:id', auth, (c) => {
    syncHarness();
    const row = db.get<TemplateRow>('SELECT * FROM templates WHERE id = ?', Number(c.req.param('id')));
    return row ? c.json(detail(row)) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/api/templates/:id', auth, (c) => {
    const row = db.get<TemplateRow>('SELECT * FROM templates WHERE id = ?', Number(c.req.param('id')));
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.name === HARNESS) return c.json({ error: 'the built-in template cannot be deleted' }, 409);
    if (db.get('SELECT 1 AS x FROM prompts WHERE template_id = ?', row.id)) return c.json({ error: 'saved prompts still use this template' }, 409);
    db.run('DELETE FROM templates WHERE id = ?', row.id);
    db.audit('web', 'template_delete', String(row.id), { name: row.name });
    return c.json({ ok: true });
  });

  // ---------- prompts ----------

  app.get('/api/prompts', auth, (c) => {
    const q = (c.req.query('q') ?? '').trim();
    const tag = (c.req.query('tag') ?? '').trim().toLowerCase();
    const where: string[] = [];
    const args: string[] = [];
    if (q) {
      where.push("(p.title LIKE ? ESCAPE '\\' OR p.rendered LIKE ? ESCAPE '\\' OR p.tags LIKE ? ESCAPE '\\')");
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      args.push(like, like, like);
    }
    if (tag) {
      where.push("(',' || p.tags || ',') LIKE ?");
      args.push(`%,${tag.replace(/[\\%_]/g, '')},%`);
    }
    const rows = db.all<PromptRow>(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.updated_at DESC, p.id DESC LIMIT 500`, ...args);
    const stats = statsFor(rows.length ? rows.map((r) => r.id) : [-1]);
    return c.json(rows.map((r) => view(r, stats.get(r.id) ?? noStats())));
  });

  app.post('/api/prompts', auth, async (c) => {
    const p = promptSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: 'title and template are required' }, 400);
    const { templateId, title, slots = {}, extraMd = '', tags = [] } = p.data;
    if (templateId == null || !render(templateId, slots, extraMd)) return c.json({ error: 'unknown template' }, 400);
    const id = create(templateId, title, slots, extraMd, tags);
    db.audit('web', 'prompt_create', String(id), { title });
    return c.json(load(id), 201);
  });

  app.get('/api/prompts/:id', auth, (c) => {
    const p = load(Number(c.req.param('id')));
    return p ? c.json(p) : c.json({ error: 'not found' }, 404);
  });

  app.put('/api/prompts/:id', auth, async (c) => {
    const id = Number(c.req.param('id'));
    const cur = load(id);
    if (!cur) return c.json({ error: 'not found' }, 404);
    const p = promptSchema.partial().safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: 'invalid prompt' }, 400);
    const d = p.data;
    const title = d.title ?? cur.title;
    const slots = d.slots ?? cur.slots;
    const extraMd = d.extraMd ?? cur.extraMd;
    const tags = cleanTags(d.tags ?? cur.tags);
    const r = render(d.templateId === undefined ? cur.templateId : d.templateId, slots, extraMd);
    if (!r) return c.json({ error: 'unknown template' }, 400);
    db.tx(() => {
      const now = Date.now();
      db.run('UPDATE prompts SET template_id = ?, title = ?, slots_json = ?, extra_md = ?, rendered = ?, tags = ?, updated_at = ? WHERE id = ?', r.templateId, title, JSON.stringify(slots), extraMd, r.rendered, tags.join(','), now, id);
      db.run('INSERT INTO prompt_versions (prompt_id, version, slots_json, extra_md, rendered, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, cur.version + 1, JSON.stringify(slots), extraMd, r.rendered, now);
      reindex(id, title, r.rendered);
    });
    db.audit('web', 'prompt_update', String(id), { title, version: cur.version + 1 });
    return c.json(load(id));
  });

  app.post('/api/prompts/:id/duplicate', auth, (c) => {
    const cur = load(Number(c.req.param('id')));
    if (!cur || cur.templateId == null) return c.json({ error: 'not found' }, 404);
    const id = create(cur.templateId, `${cur.title} (copy)`.slice(0, 200), cur.slots, cur.extraMd, cur.tags);
    db.audit('web', 'prompt_duplicate', String(id), { from: cur.id });
    return c.json(load(id), 201);
  });

  app.get('/api/prompts/:id/versions', auth, (c) => {
    const id = Number(c.req.param('id'));
    if (!db.get('SELECT 1 AS x FROM prompts WHERE id = ?', id)) return c.json({ error: 'not found' }, 404);
    const rows = db.all<{ version: number; slots_json: string; extra_md: string; rendered: string; created_at: number }>('SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY version DESC', id);
    const out: PromptVersion[] = rows.map((r) => ({ version: r.version, slots: json<Values>(r.slots_json, {}) ?? {}, extraMd: r.extra_md, rendered: r.rendered, createdAt: r.created_at }));
    return c.json(out);
  });

  app.delete('/api/prompts/:id', auth, (c) => {
    const id = Number(c.req.param('id'));
    const cur = db.get<{ title: string }>('SELECT title FROM prompts WHERE id = ?', id);
    if (!cur) return c.json({ error: 'not found' }, 404);
    db.tx(() => {
      db.run('DELETE FROM prompts WHERE id = ?', id);
      db.run("DELETE FROM search_index WHERE kind = 'prompt' AND ref = ?", `prompt-${id}`);
    });
    db.audit('web', 'prompt_delete', String(id), { title: cur.title });
    return c.json({ ok: true });
  });

  return app;
}

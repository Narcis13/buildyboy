// Factory projects for the PWA (SPEC §12.1): list, create, read, change, delete, and the state actions. Web login (and
// CSRF) like every web route; agents read projects with projects_list / projects_get. The §5 checkout projects stay at
// /api/projects.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { requireWeb } from '../auth.ts';
import { PROJECT_ACTIONS, PROJECT_STATES, projectCreateSchema, projectPatchSchema, type ProjectAction, type ProjectState } from '../../shared/factory.ts';
import { FactoryError } from '../factory/tasks.ts';
import { createProject, deleteProject, getProject, listProjects, projectAction, projectView, updateProject } from '../factory/projects.ts';

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ');

function fail(c: Context, e: unknown) {
  if (e instanceof FactoryError) return c.json({ error: e.message }, e.status as 400);
  throw e;
}

/** The request path's last segment, decoded. */
export const lastSegment = (c: Context) => decodeURIComponent(c.req.path.slice(c.req.path.lastIndexOf('/') + 1));

export function projectsRoutes(ctx: Ctx) {
  const app = new Hono();
  const web = requireWeb(ctx);

  app.get('/api/factory/projects', web, (c) => {
    const s = c.req.query('state');
    if (s && s !== 'all' && !PROJECT_STATES.includes(s as ProjectState)) return c.json({ error: 'state: active, paused, archived or all' }, 400);
    return c.json(listProjects(ctx, { state: (s || undefined) as ProjectState | 'all' | undefined }));
  });

  app.post('/api/factory/projects', web, async (c) => {
    const b = projectCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: `invalid project: ${issues(b.error)}` }, 400);
    try {
      return c.json(projectView(ctx, createProject(ctx, b.data, 'web').key), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/api/factory/projects/:key', web, (c) => {
    try {
      return c.json(getProject(ctx, c.req.param('key')));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.put('/api/factory/projects/:key', web, async (c) => {
    const b = projectPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: `invalid project: ${issues(b.error)}` }, 400);
    try {
      return c.json(projectView(ctx, updateProject(ctx, c.req.param('key'), b.data, 'web').key));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.delete('/api/factory/projects/:key', web, (c) => {
    try {
      deleteProject(ctx, c.req.param('key'), 'web');
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post(`/api/factory/projects/:key/:action{${PROJECT_ACTIONS.join('|')}}`, web, async (c) => {
    // the whole last segment: Hono's trie router matches a {a|b} parameter as a prefix ("archivex" → "archive")
    const action = lastSegment(c);
    if (!PROJECT_ACTIONS.includes(action as ProjectAction)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { on?: unknown } | null;
    try {
      const on = typeof body?.on === 'boolean' ? body.on : undefined;
      return c.json(projectAction(ctx, c.req.param('key'), action as ProjectAction, 'web', { on }));
    } catch (e) {
      return fail(c, e);
    }
  });

  return app;
}

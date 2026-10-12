import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { ActionAnswer } from '../../shared/types.ts';
import {
  clientIp, createPairingCode, createWebSession, destroyWebSession, ensureSetupToken, hasPassword, noteFailure, requireWeb, tooManyFailures,
  rotateMachineToken, setPassword, verifyPassword, webUser,
} from '../auth.ts';
import { json } from '../db.ts';
import { attention, listMachines, listSessions, queuedMessages, sessionDetail, timeline } from '../queries.ts';
import { answerPending, getPending, listPending } from '../control/pending.ts';
import { wakePaused } from '../control/control.ts';
import { search } from '../search.ts';
import { exportMarkdown } from '../export.ts';

const answerSchema: z.ZodType<ActionAnswer> = z.union([
  z.object({ type: z.literal('allow'), scope: z.enum(['once', 'session']).optional(), updatedInput: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal('deny'), message: z.string().max(4000).optional(), interrupt: z.boolean().optional() }),
  z.object({ type: z.literal('answers'), answers: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('reply'), text: z.string().min(1).max(20000) }),
  z.object({ type: z.literal('release') }),
]);

/** Settings readable/writable from the web. Secrets are write-only. */
const SETTINGS = ['walk_mode', 'pause_all', 'stop_wait_min', 'retention_days', 'redaction_rules', 'budget_session_usd', 'budget_job_usd',
  'watchers', 'ntfy_url', 'quiet_hours', 'push_types', 'github_token', 'context_threshold_pct'] as const;
const SECRET_SETTINGS = new Set(['github_token']);

export function webRoutes(ctx: Ctx) {
  const app = new Hono();
  const auth = requireWeb(ctx);
  const { db, bus } = ctx;

  // ---------- auth (public) ----------
  app.get('/api/me', (c) => {
    const u = webUser(ctx, c);
    return c.json({ authenticated: !!u, setupRequired: !hasPassword(ctx), csrf: u?.csrf ?? null });
  });

  app.post('/api/auth/login', async (c) => {
    if (tooManyFailures(clientIp(c))) return c.json({ error: 'too many attempts, wait a minute' }, 429);
    const body = await c.req.json().catch(() => ({}));
    if (!verifyPassword(String(body?.password ?? ''), db.getSetting<string | null>('password_hash', null))) {
      noteFailure(clientIp(c));
      db.audit('web', 'login_failed', clientIp(c));
      return c.json({ error: 'wrong password' }, 401);
    }
    createWebSession(ctx, c);
    db.audit('web', 'login', clientIp(c));
    return c.json({ ok: true });
  });

  app.post('/api/auth/setup', async (c) => {
    if (tooManyFailures(clientIp(c))) return c.json({ error: 'too many attempts' }, 429);
    const body = await c.req.json().catch(() => ({}));
    const token = ensureSetupToken(ctx);
    if (!token || body?.token !== token) {
      noteFailure(clientIp(c));
      return c.json({ error: 'invalid setup token' }, 403);
    }
    const pw = String(body?.password ?? '');
    if (pw.length < 8) return c.json({ error: 'password must be at least 8 characters' }, 400);
    setPassword(ctx, pw);
    createWebSession(ctx, c);
    db.audit('web', 'setup_password');
    return c.json({ ok: true });
  });

  app.post('/api/auth/logout', auth, (c) => {
    destroyWebSession(ctx, c);
    return c.json({ ok: true });
  });

  app.post('/api/auth/password', auth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!verifyPassword(String(body?.current ?? ''), db.getSetting<string | null>('password_hash', null))) return c.json({ error: 'wrong password' }, 401);
    if (String(body?.next ?? '').length < 8) return c.json({ error: 'password must be at least 8 characters' }, 400);
    setPassword(ctx, String(body.next));
    db.audit('web', 'password_changed');
    return c.json({ ok: true });
  });

  app.get('/api/auth/devices', auth, (c) => {
    const me = webUser(ctx, c)!;
    const rows = db.all<{ id: string; device: string; ip: string; created_at: number; last_seen_at: number }>('SELECT id, device, ip, created_at, last_seen_at FROM web_sessions WHERE expires_at > ? ORDER BY last_seen_at DESC', Date.now());
    return c.json(rows.map((r) => ({ ...r, current: r.id === me.sessionId })));
  });

  app.delete('/api/auth/devices/:id', auth, (c) => {
    db.run('DELETE FROM web_sessions WHERE id = ?', c.req.param('id'));
    db.audit('web', 'device_logout', c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---------- live stream ----------
  app.get('/api/stream', auth, (c) => {
    const topics = new Set((c.req.query('topics') ?? 'floor,inbox').split(',').filter(Boolean));
    const want = (t: string) => topics.has(t) || topics.has('*') || (t.startsWith('session:') && topics.has('session:*'));
    const lastId = Number(c.req.header('last-event-id') ?? c.req.query('lastEventId') ?? 0);
    return streamSSE(c, async (stream) => {
      const queue: { id: number; topic: string; type: string; data?: unknown }[] = [];
      let wake: (() => void) | null = null;
      const unsub = bus.subscribe((e) => {
        if (!want(e.topic)) return;
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        unsub();
        wake?.();
      });
      if (lastId > 0) {
        const missed = bus.since(lastId);
        if (missed === null) await stream.writeSSE({ event: 'reset', data: '{}', id: String(bus.lastId) });
        else for (const e of missed) if (want(e.topic)) queue.push(e);
      } else {
        await stream.writeSSE({ event: 'hello', data: JSON.stringify({ lastId: bus.lastId }), id: String(bus.lastId) });
      }
      while (!stream.aborted) {
        while (queue.length) {
          const e = queue.shift()!;
          await stream.writeSSE({ id: String(e.id), event: 'message', data: JSON.stringify({ topic: e.topic, type: e.type, data: e.data }) });
        }
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 25_000);
        });
        wake = null;
        if (!queue.length && !stream.aborted) await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
      }
      unsub();
    });
  });

  // ---------- floor + sessions ----------
  app.get('/api/attention', auth, (c) => c.json(attention(ctx)));

  app.get('/api/sessions', auth, (c) => {
    const q = c.req.query();
    return c.json(listSessions(ctx, {
      live: q.live === '1',
      since: q.since ? Number(q.since) : undefined,
      projectId: q.project ? Number(q.project) : undefined,
      machineId: q.machine || undefined,
      limit: q.limit ? Math.min(1000, Number(q.limit)) : undefined,
    }));
  });

  app.get('/api/sessions/:id', auth, (c) => {
    const s = sessionDetail(ctx, c.req.param('id'));
    return s ? c.json(s) : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/sessions/:id/timeline', auth, (c) => {
    const cursor = c.req.query('cursor');
    return c.json(timeline(ctx, c.req.param('id'), cursor ? Number(cursor) : undefined));
  });

  app.get('/api/sessions/:id/side', auth, (c) => {
    const sid = c.req.param('id');
    const todos = db.get<{ items_json: string; ts: number }>('SELECT items_json, ts FROM todos WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT 1', sid);
    const progress = db.get<{ content: string; ts: number }>('SELECT content, ts FROM progress_docs WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT 1', sid);
    return c.json({
      todos: todos ? { ts: todos.ts, items: json(todos.items_json, []) } : null,
      files: db.all('SELECT path, COUNT(*) AS edits, SUM(added) AS added, SUM(removed) AS removed, MAX(ts) AS lastTs FROM file_changes WHERE session_id = ? GROUP BY path ORDER BY edits DESC', sid),
      fileChanges: db.all('SELECT id, tool_use_id AS toolUseId, ts, path, op, added, removed, patch FROM file_changes WHERE session_id = ? ORDER BY ts DESC LIMIT 200', sid),
      git: {
        snapshots: db.all('SELECT ts, trigger, branch, sha, ahead, behind, dirty, shortstat FROM git_snapshots WHERE session_id = ? ORDER BY ts', sid),
        commits: db.all('SELECT sha, ts, message, author, files, added, removed FROM commits WHERE session_id = ? ORDER BY ts', sid),
        prs: db.all('SELECT number, url, title, state, branch, review_state AS reviewState, checks_state AS checksState, updated_at AS updatedAt FROM pull_requests WHERE session_id = ? ORDER BY updated_at DESC', sid),
      },
      subagents: db.all('SELECT agent_id AS agentId, agent_type AS agentType, description, started_at AS startedAt, ended_at AS endedAt, status FROM subagents WHERE session_id = ? ORDER BY started_at', sid),
      progress: progress ?? null,
      queued: queuedMessages(ctx, sid),
      pending: db.all("SELECT id, kind, tool_name AS toolName, created_at AS createdAt FROM pending_actions WHERE session_id = ? AND status = 'pending'", sid),
    });
  });

  app.get('/api/sessions/:id/events', auth, (c) => {
    const limit = Math.min(2000, Number(c.req.query('limit') ?? 500));
    const rows = db.all<{ id: number; ts: number; event: string; tool_name: string | null; summary: string | null; payload_json: string }>(
      'SELECT id, ts, event, tool_name, summary, payload_json FROM events WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT ?', c.req.param('id'), limit,
    );
    return c.json(rows.map((r) => ({ id: r.id, ts: r.ts, event: r.event, toolName: r.tool_name, summary: r.summary, payload: json(r.payload_json) })));
  });

  app.get('/api/sessions/:id/export.md', auth, (c) => {
    const md = exportMarkdown(ctx, c.req.param('id'));
    if (md == null) return c.json({ error: 'not found' }, 404);
    return c.body(md, 200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="session-${c.req.param('id').slice(0, 8)}.md"` });
  });

  // ---------- session control ----------
  app.post('/api/sessions/:id/messages', auth, async (c) => {
    const sid = c.req.param('id');
    if (!db.get('SELECT 1 FROM sessions WHERE id = ?', sid)) return c.json({ error: 'not found' }, 404);
    const b = z.object({ text: z.string().min(1).max(20000), mode: z.enum(['now', 'after_turn']).default('after_turn') }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'text required' }, 400);
    const id = randomUUID();
    // If the session is holding at Stop waiting for me, the message answers that wait directly.
    const wait = db.get<{ id: string }>("SELECT id FROM pending_actions WHERE session_id = ? AND kind = 'stop_wait' AND status = 'pending' ORDER BY created_at DESC LIMIT 1", sid);
    if (wait && answerPending(ctx, wait.id, { type: 'reply', text: b.data.text }, 'web')) {
      db.run("INSERT INTO queued_messages (id, session_id, text, mode, status, created_at, delivered_at, delivered_via) VALUES (?, ?, ?, ?, 'delivered', ?, ?, 'stop')", id, sid, b.data.text, b.data.mode, Date.now(), Date.now());
    } else {
      db.run("INSERT INTO queued_messages (id, session_id, text, mode, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)", id, sid, b.data.text, b.data.mode, Date.now());
    }
    db.audit('web', 'queue_message', sid, { id, mode: b.data.mode });
    bus.publish(`session:${sid}`, 'queue');
    bus.publish('floor', 'session', { id: sid });
    return c.json({ id });
  });

  app.delete('/api/sessions/:id/messages/:mid', auth, (c) => {
    db.run("UPDATE queued_messages SET status = 'cancelled' WHERE id = ? AND session_id = ? AND status = 'queued'", c.req.param('mid'), c.req.param('id'));
    db.audit('web', 'cancel_message', c.req.param('id'), { id: c.req.param('mid') });
    bus.publish(`session:${c.req.param('id')}`, 'queue');
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/:action{stop|pause|resume|walk|mute}', auth, async (c) => {
    const sid = c.req.param('id');
    const action = c.req.param('action');
    const s = db.get<{ job_id: string | null; machine_id: string }>('SELECT job_id, machine_id FROM sessions WHERE id = ?', sid);
    if (!s) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (action === 'stop') {
      db.run('UPDATE sessions SET kill_requested = 1, paused = 0 WHERE id = ?', sid);
      // release anything the session is waiting on so the next PreToolUse can deliver the stop
      for (const p of db.all<{ id: string; kind: string }>("SELECT id, kind FROM pending_actions WHERE session_id = ? AND status = 'pending'", sid)) {
        answerPending(ctx, p.id, p.kind === 'stop_wait' || p.kind === 'pause' ? { type: 'release' } : { type: 'deny', message: 'Session stopped from Buildyboy', interrupt: true }, 'web');
      }
      wakePaused(ctx, sid);
      if (s.job_id) ctx.runners.get(s.machine_id)?.({ type: 'stop', jobId: s.job_id });
    } else if (action === 'pause') db.run('UPDATE sessions SET paused = 1 WHERE id = ?', sid);
    else if (action === 'resume') {
      db.run('UPDATE sessions SET paused = 0 WHERE id = ?', sid);
      wakePaused(ctx, sid);
    } else if (action === 'walk') {
      const on = body?.on === null || body?.on === undefined ? null : body.on ? 1 : 0;
      db.run('UPDATE sessions SET walk_mode = ? WHERE id = ?', on, sid);
      if (typeof body?.stopWaitMin === 'number') db.run('UPDATE sessions SET stop_wait_min = ? WHERE id = ?', Math.max(0, Math.min(60, body.stopWaitMin)), sid);
    } else if (action === 'mute') {
      const muted = new Set(db.getSetting<string[]>('push_muted_sessions', []));
      if (body?.on) muted.add(sid);
      else muted.delete(sid);
      db.setSetting('push_muted_sessions', [...muted]);
    }
    db.audit('web', `session_${action}`, sid, body);
    bus.publish('floor', 'session', { id: sid });
    bus.publish(`session:${sid}`, 'control');
    return c.json({ ok: true });
  });

  // ---------- inbox ----------
  app.get('/api/inbox', auth, (c) => c.json({ pending: listPending(ctx, 'pending').filter((p) => p.kind !== 'pause'), history: listPending(ctx, 'history', 50) }));

  app.post('/api/actions/:id/answer', auth, async (c) => {
    const id = c.req.param('id');
    const parsed = answerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid answer' }, 400);
    const p = getPending(ctx, id);
    if (!p) return c.json({ error: 'not found' }, 404);
    if (p.status !== 'pending') return c.json({ error: `already ${p.status}` }, 409);
    const ok = answerPending(ctx, id, parsed.data as Record<string, unknown>, 'web');
    db.audit('web', 'answer', id, parsed.data);
    return ok ? c.json({ ok: true }) : c.json({ error: 'already answered' }, 409);
  });

  // ---------- global controls ----------
  app.post('/api/global/:what{walk|pause}', auth, async (c) => {
    const on = !!(await c.req.json().catch(() => ({})))?.on;
    const key = c.req.param('what') === 'walk' ? 'walk_mode' : 'pause_all';
    db.setSetting(key, on);
    if (key === 'pause_all' && !on) wakePaused(ctx);
    db.audit('web', `global_${c.req.param('what')}`, null, { on });
    bus.publish('floor', 'global');
    bus.publish('machines', 'changed');
    return c.json({ ok: true });
  });

  app.get('/api/global', auth, (c) => c.json({ walk: db.getSetting('walk_mode', false), pauseAll: db.getSetting('pause_all', false) }));

  // ---------- machines ----------
  app.get('/api/machines', auth, (c) => c.json(listMachines(ctx)));

  app.post('/api/machines/:id/:action{walk|rotate|revoke|rename}', auth, async (c) => {
    const id = c.req.param('id');
    const action = c.req.param('action');
    if (!db.get('SELECT 1 FROM machines WHERE id = ?', id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    let out: Record<string, unknown> = { ok: true };
    if (action === 'walk') db.run('UPDATE machines SET walk_mode = ? WHERE id = ?', body?.on === null || body?.on === undefined ? null : body.on ? 1 : 0, id);
    else if (action === 'rotate') out = { ok: true, token: rotateMachineToken(ctx, id) };
    else if (action === 'revoke') db.run('UPDATE machines SET revoked = 1 WHERE id = ?', id);
    else if (action === 'rename' && typeof body?.name === 'string' && body.name.trim()) db.run('UPDATE machines SET name = ? WHERE id = ?', body.name.trim().slice(0, 80), id);
    db.audit('web', `machine_${action}`, id);
    bus.publish('machines', 'changed');
    bus.publish('floor', 'machines');
    return c.json(out);
  });

  app.post('/api/pairing-codes', auth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { code, expiresAt } = createPairingCode(ctx, typeof body?.name === 'string' ? body.name : undefined);
    db.audit('web', 'pairing_code');
    const url = ctx.config.publicUrl;
    return c.json({
      code,
      expiresAt,
      commands: {
        bash: `curl -fsSL ${url}/install.sh | bash -s -- ${code}`,
        powershell: `$env:BB_CODE='${code}'; irm ${url}/install.ps1 | iex`,
      },
    });
  });

  // ---------- projects ----------
  app.get('/api/projects', auth, (c) =>
    c.json(db.all(`SELECT p.id, p.machine_id AS machineId, m.name AS machineName, p.root_path AS rootPath, p.name, p.git_remote AS gitRemote, p.gh_owner AS ghOwner, p.gh_repo AS ghRepo,
      (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS sessions, (SELECT MAX(last_event_at) FROM sessions s WHERE s.project_id = p.id) AS lastEventAt,
      (SELECT COALESCE(SUM(cost_usd),0) FROM sessions s WHERE s.project_id = p.id) AS costUsd
      FROM projects p JOIN machines m ON m.id = p.machine_id ORDER BY lastEventAt DESC`)));

  app.get('/api/projects/:id', auth, (c) => {
    const id = Number(c.req.param('id'));
    const p = db.get('SELECT p.*, m.name AS machine_name FROM projects p JOIN machines m ON m.id = p.machine_id WHERE p.id = ?', id);
    if (!p) return c.json({ error: 'not found' }, 404);
    return c.json({
      project: p,
      sessions: listSessions(ctx, { projectId: id, limit: 100 }),
      jobs: db.all('SELECT id, title, status, cost_usd AS costUsd, created_at AS createdAt, ended_at AS endedAt FROM jobs WHERE cwd = ? OR cwd LIKE ? ORDER BY created_at DESC LIMIT 50', p.root_path as string, `${p.root_path}%`),
      prs: db.all('SELECT number, url, title, state, branch, checks_state AS checksState, updated_at AS updatedAt, session_id AS sessionId FROM pull_requests WHERE project_id = ? ORDER BY updated_at DESC', id),
      commits: db.all('SELECT sha, ts, message, author, files, added, removed, session_id AS sessionId FROM commits WHERE project_id = ? ORDER BY ts DESC LIMIT 100', id),
      costByDay: db.all("SELECT date(started_at/1000, 'unixepoch') AS day, SUM(cost_usd) AS cost FROM sessions WHERE project_id = ? GROUP BY day ORDER BY day", id),
      progress: db.all('SELECT d.session_id AS sessionId, d.ts, d.content FROM progress_docs d JOIN sessions s ON s.id = d.session_id WHERE s.project_id = ? ORDER BY d.ts DESC LIMIT 5', id),
    });
  });

  // ---------- search ----------
  app.get('/api/search', auth, (c) => c.json(search(db, c.req.query('q') ?? '')));

  // ---------- settings ----------
  app.get('/api/settings', auth, (c) => {
    const out: Record<string, unknown> = {};
    for (const k of SETTINGS) {
      const v = db.getSetting<unknown>(k, null);
      out[k] = SECRET_SETTINGS.has(k) ? (v ? '••••••' : null) : v;
    }
    out.public_url = ctx.config.publicUrl;
    out.vapid_public_key = db.getSetting<{ publicKey: string } | null>('vapid', null)?.publicKey ?? null;
    return c.json(out);
  });

  app.put('/api/settings', auth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const changed: string[] = [];
    for (const k of SETTINGS) {
      if (!(k in body)) continue;
      if (SECRET_SETTINGS.has(k) && body[k] === '••••••') continue;
      if (body[k] === null) db.run('DELETE FROM settings WHERE key = ?', k);
      else db.setSetting(k, body[k]);
      changed.push(k);
    }
    db.audit('web', 'settings', null, changed);
    bus.publish('floor', 'global');
    return c.json({ ok: true, changed });
  });

  app.get('/api/audit', auth, (c) => c.json(db.all('SELECT ts, actor, action, target, detail FROM audit_log ORDER BY id DESC LIMIT 200')));

  return app;
}

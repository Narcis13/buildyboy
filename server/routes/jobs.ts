import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { JobStatus, RunnerEvent } from '../../shared/types.ts';
import { requireMachine, requireWeb } from '../auth.ts';
import { json } from '../db.ts';
import { jobView, rowToJob } from '../queries.ts';
import { checkOptions, OptionError, type StoredJobOptions } from '../../runner/options.ts';
import {
  applyRunnerEvents, createJob, dispatch, doneWhenCommands, JobError, reconcile, runnerInfo, sendToRunner, TERMINAL, under, type NewJob,
} from '../jobs/core.ts';
import { nextRun, parseCron } from '../jobs/cron.ts';

type Vars = { Variables: { machineId: string } };

const STATUSES: JobStatus[] = ['queued', 'starting', 'running', 'succeeded', 'failed', 'stopped', 'lost'];

const createSchema = z.object({
  promptId: z.coerce.number().int().positive().nullish(),
  promptText: z.string().max(200_000).nullish(),
  machineId: z.string().min(1).max(100),
  cwd: z.string().min(1).max(1000),
  title: z.string().max(200).nullish(),
  options: z.record(z.string(), z.unknown()).default({}),
});

const runnerEventSchema = z.union([
  z.object({
    type: z.literal('status'),
    status: z.enum(STATUSES as [JobStatus, ...JobStatus[]]),
    sessionId: z.string().max(100).optional(),
    exitCode: z.number().int().nullish(),
    costUsd: z.number().nonnegative().nullish(),
    result: z.record(z.string(), z.unknown()).nullish(),
  }),
  z.object({ type: z.literal('output'), lines: z.array(z.string().max(1_000_000)).max(5000) }),
  z.object({
    type: z.literal('verify'),
    results: z.array(z.object({ command: z.string().max(4000), ok: z.boolean(), exitCode: z.number().int().nullable(), output: z.string().max(200_000) })).max(50),
  }),
]);

const heartbeatSchema = z.object({
  version: z.string().max(50).optional(),
  hostname: z.string().max(200).optional(),
  platform: z.string().max(50).optional(),
  allowedRoots: z.array(z.string().max(1000)).max(100).optional(),
  concurrency: z.number().int().positive().max(64).optional(),
  claudeVersion: z.string().max(100).nullish(),
  running: z.array(z.object({ jobId: z.string().max(100), sessionId: z.string().max(100).nullish(), pid: z.number().nullish(), startedAt: z.number().nullish(), cwd: z.string().max(1000).nullish() })).max(200).default([]),
});

const BG_STATUS: Record<string, string> = { working: 'working', blocked: 'waiting', done: 'ended', failed: 'error', stopped: 'ended' };

const msTime = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
};

const withDefaults = (o: Record<string, unknown>) => ({ ...o, maxBudgetUsd: o.maxBudgetUsd ?? 5 });

export function jobsRoutes(ctx: Ctx) {
  const app = new Hono<Vars>();
  const mauth = requireMachine(ctx);
  const wauth = requireWeb(ctx);
  const { db, bus } = ctx;

  const fail = (c: Context, e: unknown) => {
    if (e instanceof JobError) return c.json({ error: e.message }, e.status as 400);
    if (e instanceof OptionError) return c.json({ error: e.message }, 400);
    throw e;
  };

  // ---------- runner (machine token) ----------
  app.get('/api/runner/stream', mauth, (c) => {
    const machineId = c.get('machineId');
    return streamSSE(c, async (stream) => {
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      const send = (cmd: unknown) => {
        queue.push(cmd);
        wake?.();
      };
      ctx.runners.set(machineId, send); // a newer connection from the same runner replaces the old one
      db.run('UPDATE machines SET runner_online = 1, runner_seen_at = ? WHERE id = ?', Date.now(), machineId);
      bus.publish('machines', 'changed');
      stream.onAbort(() => {
        if (ctx.runners.get(machineId) === send) {
          ctx.runners.delete(machineId);
          try {
            db.run('UPDATE machines SET runner_online = 0, runner_seen_at = ? WHERE id = ?', Date.now(), machineId);
            bus.publish('machines', 'changed');
          } catch {
            // server shutting down
          }
        }
        wake?.();
      });
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ machineId }) });
      dispatch(ctx, machineId);
      while (!stream.aborted) {
        // a revoked machine loses its live connection too, not just new requests
        if (db.get<{ revoked: number }>('SELECT revoked FROM machines WHERE id = ?', machineId)?.revoked) break;
        while (queue.length && !stream.aborted) await stream.writeSSE({ event: 'command', data: JSON.stringify(queue.shift()) });
        await new Promise<void>((r) => {
          const t = setTimeout(r, 25_000);
          wake = () => {
            clearTimeout(t);
            r();
          };
        });
        wake = null;
        if (!queue.length && !stream.aborted) await stream.writeSSE({ event: 'command', data: JSON.stringify({ type: 'ping' }) });
      }
    });
  });

  app.post('/api/runner/heartbeat', mauth, async (c) => {
    const machineId = c.get('machineId');
    const p = heartbeatSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: 'bad heartbeat' }, 400);
    const now = Date.now();
    db.run(
      'UPDATE machines SET runner_info_json = ?, runner_seen_at = ?, last_seen = ?, runner_online = ?, claude_version = COALESCE(claude_version, ?) WHERE id = ?',
      JSON.stringify({ ...p.data, at: now }), now, now, ctx.runners.has(machineId) ? 1 : 0, p.data.claudeVersion ?? null, machineId,
    );
    reconcile(ctx, machineId, p.data.running.map((r) => r.jobId), now);
    dispatch(ctx, machineId);
    bus.publish('machines', 'changed');
    return c.json({ ok: true });
  });

  app.post('/api/runner/agents', mauth, async (c) => {
    const machineId = c.get('machineId');
    const b = (await c.req.json().catch(() => null)) as { agents?: unknown } | null;
    const raw = b?.agents as unknown;
    const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray((raw as { agents?: unknown })?.agents) ? (raw as { agents: unknown[] }).agents : [];
    const touched: string[] = [];
    const now = Date.now();
    for (const item of list.slice(0, 500)) {
      if (!item || typeof item !== 'object') continue;
      const a = item as Record<string, unknown>;
      const id = [a.sessionId, a.session_id, a.id].find((v): v is string => typeof v === 'string' && /^[\w-]{6,100}$/.test(v));
      if (!id) continue;
      const status = BG_STATUS[String(a.state ?? a.status ?? '').toLowerCase()] ?? 'idle';
      const s = db.get<{ machine_id: string; hooked: number }>('SELECT machine_id, EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id) hooked FROM sessions s WHERE id = ?', id);
      if (s && (s.machine_id !== machineId || s.hooked)) continue; // hooks know this session better
      const started = msTime(a.startedAt ?? a.started_at ?? a.createdAt ?? a.created_at) ?? now;
      const updated = msTime(a.updatedAt ?? a.updated_at ?? a.lastActivity) ?? now;
      const name = [a.name, a.title, a.description].find((v): v is string => typeof v === 'string')?.slice(0, 200) ?? null;
      const cwd = typeof a.cwd === 'string' ? a.cwd.slice(0, 1000) : null;
      const ended = status === 'ended' || status === 'error' ? updated : null;
      if (!s) {
        db.run(
          `INSERT INTO sessions (id, machine_id, cwd, source, name, status, started_at, last_event_at, ended_at) VALUES (?, ?, ?, 'bg', ?, ?, ?, ?, ?)`,
          id, machineId, cwd, name, status, started, updated, ended,
        );
      } else {
        db.run('UPDATE sessions SET status = ?, name = COALESCE(name, ?), cwd = COALESCE(cwd, ?), last_event_at = MAX(last_event_at, ?), ended_at = ? WHERE id = ?', status, name, cwd, updated, ended, id);
      }
      touched.push(id);
    }
    for (const id of touched) bus.publish('floor', 'session', { id });
    return c.json({ ok: true, upserted: touched.length });
  });

  app.post('/api/runner/jobs/:id/events', mauth, async (c) => {
    const b = (await c.req.json().catch(() => null)) as { events?: unknown } | unknown[] | null;
    const raw = Array.isArray(b) ? b : Array.isArray(b?.events) ? b.events : b ? [b] : [];
    const events: RunnerEvent[] = [];
    for (const e of raw.slice(0, 1000)) {
      const p = runnerEventSchema.safeParse(e);
      if (!p.success) return c.json({ error: 'bad event' }, 400);
      events.push(p.data as RunnerEvent);
    }
    try {
      applyRunnerEvents(ctx, c.get('machineId'), c.req.param('id'), events);
    } catch (e) {
      return fail(c, e);
    }
    return c.json({ ok: true });
  });

  // ---------- jobs (web) ----------
  const detail = (id: string) => {
    const j = jobView(ctx, id);
    if (!j) return null;
    const extra = db.get<{ output_lines: number; rerun_of: string | null; schedule_id: string | null }>('SELECT output_lines, rerun_of, schedule_id FROM jobs WHERE id = ?', id)!;
    const o = j.options as StoredJobOptions;
    return {
      ...j,
      outputLines: extra.output_lines,
      rerunOf: extra.rerun_of,
      scheduleId: extra.schedule_id,
      runnerOnline: ctx.runners.has(j.machineId),
      verifyCommands: o.verify?.length ? o.verify : doneWhenCommands(j.promptText),
    };
  };

  app.get('/api/jobs', wauth, (c) => {
    const q = c.req.query();
    const where: string[] = [];
    const params: (string | number)[] = [];
    const statuses = (q.status ?? '').split(',').filter((s) => STATUSES.includes(s as JobStatus));
    if (statuses.length) {
      where.push(`j.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (q.machine) {
      where.push('j.machine_id = ?');
      params.push(q.machine);
    }
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    const rows = db.all<Record<string, unknown>>(
      `SELECT j.*, m.name AS machine_name FROM jobs j JOIN machines m ON m.id = j.machine_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY j.created_at DESC LIMIT ?`,
      ...params, limit,
    );
    return c.json(rows.map((r) => ({ ...rowToJob(r), promptText: String(r.prompt_text).slice(0, 300) })));
  });

  app.get('/api/jobs/:id', wauth, (c) => {
    const d = detail(c.req.param('id'));
    return d ? c.json(d) : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/jobs/:id/output', wauth, (c) => {
    const id = c.req.param('id');
    const j = db.get<{ output_lines: number }>('SELECT output_lines FROM jobs WHERE id = ?', id);
    if (!j) return c.json({ error: 'not found' }, 404);
    const after = Number(c.req.query('after') ?? -1);
    const limit = Math.min(2000, Math.max(1, Number(c.req.query('limit')) || 1000));
    const lines = db.all<{ seq: number; ts: number; line_json: string }>('SELECT seq, ts, line_json FROM job_output WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?', id, Number.isFinite(after) ? after : -1, limit);
    return c.json({ lines: lines.map((l) => ({ seq: l.seq, ts: l.ts, line: l.line_json })), total: j.output_lines });
  });

  app.post('/api/jobs', wauth, async (c) => {
    const p = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: `invalid job: ${p.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` }, 400);
    try {
      const id = createJob(ctx, { ...p.data, options: withDefaults(p.data.options) });
      db.audit('web', 'job_create', id, { machineId: p.data.machineId, cwd: p.data.cwd, promptId: p.data.promptId ?? null, options: p.data.options });
      return c.json({ id });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/api/jobs/fanout', wauth, async (c) => {
    const p = z
      .object({
        promptId: z.coerce.number().int().positive().nullish(),
        promptText: z.string().max(200_000).nullish(),
        title: z.string().max(200).nullish(),
        targets: z.array(z.object({ machineId: z.string().min(1).max(100), cwd: z.string().min(1).max(1000) })).min(1).max(20),
        options: z.record(z.string(), z.unknown()).default({}),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: 'invalid fan-out' }, 400);
    try {
      checkOptions(withDefaults(p.data.options));
      for (const t of p.data.targets) if (!db.get('SELECT 1 FROM machines WHERE id = ?', t.machineId)) return c.json({ error: `unknown machine ${t.machineId}` }, 400);
      const ids = p.data.targets.map((t) => createJob(ctx, { promptId: p.data.promptId, promptText: p.data.promptText, title: p.data.title, ...t, options: withDefaults(p.data.options) }));
      db.audit('web', 'job_fanout', null, { ids, promptId: p.data.promptId ?? null });
      return c.json({ ids });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/api/jobs/:id/:action{stop|message|resume|rerun|verify}', wauth, async (c) => {
    const id = c.req.param('id');
    const action = c.req.param('action');
    const j = jobView(ctx, id);
    if (!j) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const live = j.status === 'starting' || j.status === 'running';
    const o = j.options as StoredJobOptions;
    const publish = () => bus.publish('jobs', 'changed', { id });

    if (action === 'stop') {
      if (TERMINAL.includes(j.status)) return c.json({ error: `already ${j.status}` }, 409);
      let delivered = false;
      if (j.status === 'queued') {
        db.run("UPDATE jobs SET status = 'stopped', ended_at = ?, result_json = ? WHERE id = ? AND status = 'queued'", Date.now(), JSON.stringify({ reason: 'cancelled before it started' }), id);
      } else {
        delivered = sendToRunner(ctx, j.machineId, { type: 'stop', jobId: id });
        if (!delivered && j.status === 'starting') db.run("UPDATE jobs SET status = 'stopped', ended_at = ?, result_json = ? WHERE id = ?", Date.now(), JSON.stringify({ reason: 'stopped while the runner was offline' }), id);
      }
      db.audit('web', 'job_stop', id, { delivered });
      publish();
      return c.json({ ok: true, delivered });
    }

    if (action === 'message') {
      const p = z.object({ text: z.string().trim().min(1).max(20_000) }).safeParse(body);
      if (!p.success) return c.json({ error: 'text required' }, 400);
      if (!live) return c.json({ error: `job is ${j.status}` }, 409);
      if (!sendToRunner(ctx, j.machineId, { type: 'message', jobId: id, text: p.data.text })) return c.json({ error: 'runner is offline' }, 409);
      applyRunnerEvents(ctx, j.machineId, id, [{ type: 'output', lines: [JSON.stringify({ type: 'buildyboy_user', text: p.data.text, ts: Date.now() })] }]);
      db.audit('web', 'job_message', id, { length: p.data.text.length });
      return c.json({ ok: true });
    }

    if (action === 'resume' || action === 'rerun') {
      if (live || j.status === 'queued') return c.json({ error: `job is ${j.status}` }, 409);
      const { resumeSessionId: _drop, ...base } = o;
      let input: NewJob;
      if (action === 'resume') {
        if (!j.sessionId) return c.json({ error: 'no session to resume' }, 400);
        const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 20_000) : 'Continue where you left off.';
        const verify = base.verify?.length ? base.verify : doneWhenCommands(j.promptText);
        input = { promptId: j.promptId, promptText: text, machineId: j.machineId, cwd: j.cwd, title: `Resume: ${j.title ?? id.slice(0, 8)}`.slice(0, 200), options: { ...base, ...(verify.length ? { verify } : {}), resumeSessionId: j.sessionId }, rerunOf: id };
      } else {
        input = { promptId: j.promptId, promptText: j.promptText, machineId: j.machineId, cwd: j.cwd, title: j.title, options: base, rerunOf: id };
      }
      try {
        const nid = createJob(ctx, input);
        db.audit('web', `job_${action}`, id, { newJobId: nid });
        return c.json({ id: nid });
      } catch (e) {
        return fail(c, e);
      }
    }

    // verify: only with an explicit confirmation of the exact command list
    const p = z.object({ commands: z.array(z.string().trim().min(1).max(2000)).max(30).optional(), confirmed: z.literal(true) }).safeParse(body);
    if (!p.success) return c.json({ error: 'verify needs confirmed: true and a list of commands' }, 400);
    if (live || j.status === 'queued') return c.json({ error: `job is ${j.status}` }, 409);
    const commands = p.data.commands ?? (o.verify?.length ? o.verify : doneWhenCommands(j.promptText));
    if (!commands.length) return c.json({ error: 'no commands to verify' }, 400);
    if (!sendToRunner(ctx, j.machineId, { type: 'verify', jobId: id, commands, cwd: j.cwd })) return c.json({ error: 'runner is offline' }, 409);
    db.audit('web', 'job_verify', id, { commands });
    return c.json({ ok: true, commands });
  });

  // ---------- schedules ----------
  app.get('/api/schedules', wauth, (c) =>
    c.json(
      db.all<{ id: string; cron: string; job_template_json: string; enabled: number; last_run_at: number | null; created_at: number }>('SELECT * FROM schedules ORDER BY created_at DESC').map((s) => {
        let next: number | null = null;
        try {
          next = nextRun(s.cron)?.getTime() ?? null;
        } catch {
          // invalid rows can't be created through the API
        }
        return { id: s.id, cron: s.cron, enabled: !!s.enabled, lastRunAt: s.last_run_at, createdAt: s.created_at, nextRunAt: next, job: json(s.job_template_json) };
      }),
    ),
  );

  app.post('/api/schedules', wauth, async (c) => {
    const p = z.object({ cron: z.string().min(9).max(200), job: createSchema }).safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: 'invalid schedule' }, 400);
    try {
      parseCron(p.data.cron);
    } catch (e) {
      return c.json({ error: `cron: ${(e as Error).message}` }, 400);
    }
    let job: NewJob;
    try {
      job = { ...p.data.job, options: checkOptions(withDefaults(p.data.job.options)) };
    } catch (e) {
      return fail(c, e);
    }
    if (!db.get('SELECT 1 FROM machines WHERE id = ?', job.machineId)) return c.json({ error: 'unknown machine' }, 400);
    if (!job.promptId && !job.promptText?.trim()) return c.json({ error: 'promptId or promptText is required' }, 400);
    const id = randomUUID();
    db.run('INSERT INTO schedules (id, cron, job_template_json, enabled, created_at) VALUES (?, ?, ?, 1, ?)', id, p.data.cron.trim(), JSON.stringify(job), Date.now());
    db.audit('web', 'schedule_create', id, { cron: p.data.cron, machineId: job.machineId, cwd: job.cwd });
    bus.publish('jobs', 'schedules');
    return c.json({ id });
  });

  app.delete('/api/schedules/:id', wauth, (c) => {
    const id = c.req.param('id');
    const r = db.run('DELETE FROM schedules WHERE id = ?', id);
    if (!r.changes) return c.json({ error: 'not found' }, 404);
    db.audit('web', 'schedule_delete', id);
    bus.publish('jobs', 'schedules');
    return c.json({ ok: true });
  });

  // ---------- launch form helpers ----------
  app.get('/api/runner/projects', wauth, (c) => {
    const machineId = c.req.query('machine') ?? '';
    if (!db.get('SELECT 1 FROM machines WHERE id = ?', machineId)) return c.json({ error: 'unknown machine' }, 404);
    const info = runnerInfo(ctx, machineId);
    const roots = info?.allowedRoots ?? [];
    const inRoots = (p: string) => !roots.length || roots.some((r) => under(p, r));
    const projects = db.all<{ id: number; name: string; root_path: string }>('SELECT id, name, root_path FROM projects WHERE machine_id = ? ORDER BY name', machineId)
      .filter((p) => inRoots(p.root_path))
      .map((p) => ({ id: p.id, name: p.name, path: p.root_path }));
    const recent = db.all<{ cwd: string }>('SELECT cwd, MAX(created_at) t FROM jobs WHERE machine_id = ? GROUP BY cwd ORDER BY t DESC LIMIT 20', machineId).map((r) => r.cwd).filter(inRoots);
    return c.json({ runnerOnline: ctx.runners.has(machineId), allowedRoots: roots, concurrency: info?.concurrency ?? null, projects, recent });
  });

  return app;
}

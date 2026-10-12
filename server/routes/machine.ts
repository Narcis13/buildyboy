import { Hono } from 'hono';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { HookEnvelope, HookResponse, IngestResponse } from '../../shared/types.ts';
import { requireMachine } from '../auth.ts';
import { ingestEnvelope, IngestError } from '../ingest/derive.ts';
import { decide } from '../control/control.ts';
import { controlStateFor } from '../control/state.ts';

const envelopeSchema = z
  .object({
    v: z.literal(1).optional(),
    event: z.object({ session_id: z.string().min(1), hook_event_name: z.string().min(1) }).passthrough(),
    ts: z.number().optional(),
  })
  .passthrough();

type Vars = { Variables: { machineId: string } };

function publishSession(ctx: Ctx, sid: string) {
  ctx.bus.publish('floor', 'session', { id: sid });
  ctx.bus.publish(`session:${sid}`, 'timeline');
}

export function machineRoutes(ctx: Ctx) {
  const app = new Hono<Vars>();
  const auth = requireMachine(ctx);

  app.post('/api/ingest', auth, async (c) => {
    const machineId = c.get('machineId');
    const body = await c.req.json().catch(() => null);
    const list: unknown[] = Array.isArray(body) ? body : Array.isArray(body?.envelopes) ? body.envelopes : body ? [body] : [];
    let accepted = 0;
    let duplicates = 0;
    const touched = new Set<string>();
    for (const item of list) {
      const parsed = envelopeSchema.safeParse(item);
      if (!parsed.success) continue;
      try {
        const r = ingestEnvelope(ctx, machineId, parsed.data as unknown as HookEnvelope);
        if (r.duplicate) duplicates++;
        else accepted++;
        touched.add(r.sessionId);
      } catch (e) {
        if (e instanceof IngestError && e.status === 403) return c.json({ error: e.message }, 403);
        if (!(e instanceof IngestError)) console.error('[ingest]', e);
      }
    }
    for (const sid of touched) publishSession(ctx, sid);
    const res: IngestResponse = { ok: true, accepted, duplicates, control: controlStateFor(ctx, machineId) };
    return c.json(res);
  });

  app.post('/api/hook/:event', auth, async (c) => {
    const machineId = c.get('machineId');
    const parsed = envelopeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad envelope' }, 400);
    const env = parsed.data as unknown as HookEnvelope;
    if (env.controlOnly) {
      // lean PreToolUse path: its async twin ingests the event; we only decide
      const owner = ctx.db.get<{ machine_id: string }>('SELECT machine_id FROM sessions WHERE id = ?', env.event.session_id);
      if (!owner) return c.json({ output: null, control: controlStateFor(ctx, machineId) } satisfies HookResponse);
      if (owner.machine_id !== machineId) return c.json({ error: 'session belongs to another machine' }, 403);
    } else {
      try {
        ingestEnvelope(ctx, machineId, env);
      } catch (e) {
        if (e instanceof IngestError) return c.json({ error: e.message }, e.status as 400);
        throw e;
      }
      publishSession(ctx, env.event.session_id);
    }
    // Long-poll: send a byte right away so the hook knows the server is alive, then the decision.
    const ac = new AbortController();
    c.req.raw.signal?.addEventListener('abort', () => ac.abort());
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode(' '));
        let output: Record<string, unknown> | null = null;
        try {
          output = await decide(ctx, env, ac.signal);
        } catch (e) {
          console.error('[hook]', e);
        }
        const res: HookResponse = { output, control: controlStateFor(ctx, machineId) };
        try {
          controller.enqueue(enc.encode(JSON.stringify(res)));
          controller.close();
        } catch {
          // client went away
        }
      },
      cancel() {
        ac.abort();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  });

  app.post('/api/statusline', auth, async (c) => {
    const machineId = c.get('machineId');
    const b = (await c.req.json().catch(() => null)) as Record<string, any> | null;
    const sid = typeof b?.session_id === 'string' ? b.session_id : null;
    if (!sid) return c.json({ error: 'session_id required' }, 400);
    const owner = ctx.db.get<{ machine_id: string }>('SELECT machine_id FROM sessions WHERE id = ?', sid);
    if (!owner || owner.machine_id !== machineId) return c.json({ ok: false });
    const cost = typeof b?.cost?.total_cost_usd === 'number' ? b.cost.total_cost_usd : null;
    const pct = typeof b?.context_window?.used_percentage === 'number' ? b.context_window.used_percentage : null;
    ctx.db.run(
      `UPDATE sessions SET cost_usd = CASE WHEN ? IS NULL THEN cost_usd ELSE MAX(CASE WHEN cost_source = 'estimate' OR cost_source IS NULL THEN 0 ELSE cost_usd END, ?) END,
       cost_source = CASE WHEN ? IS NULL THEN cost_source ELSE 'statusline' END, context_pct = COALESCE(?, context_pct),
       rate_limits_json = COALESCE(?, rate_limits_json), model = COALESCE(?, model) WHERE id = ?`,
      cost, cost, cost, pct, b?.rate_limits ? JSON.stringify(b.rate_limits) : null, typeof b?.model?.display_name === 'string' ? b.model.display_name : null, sid,
    );
    if (b?.rate_limits) ctx.db.run('INSERT INTO otel_points (ts, session_id, name, value, attrs_json) VALUES (?, ?, ?, ?, ?)', Date.now(), sid, 'statusline.rate_limits', Number(b.rate_limits?.five_hour?.used_percentage ?? 0), JSON.stringify(b.rate_limits));
    publishSession(ctx, sid);
    return c.json({ ok: true });
  });

  return app;
}

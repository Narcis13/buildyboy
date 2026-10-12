import { Hono } from 'hono';
import type { Ctx } from '../context.ts';
import { requireMachine } from '../auth.ts';
import { rulesFor } from '../redaction.ts';
import { redactValue } from '../../shared/redact.ts';

// OTLP/HTTP JSON receiver for Claude Code's OpenTelemetry exporter
// (OTEL_EXPORTER_OTLP_PROTOCOL=http/json, OTEL_EXPORTER_OTLP_ENDPOINT=<server>, headers Authorization=Bearer <machine token>).

type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; arrayValue?: { values?: AnyValue[] } };
type KV = { key: string; value: AnyValue };

function val(v: AnyValue | undefined): unknown {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(val);
  return null;
}

export function attrs(list: KV[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of list ?? []) out[a.key] = val(a.value);
  return out;
}

const nanoToMs = (n: unknown) => (n ? Math.round(Number(n) / 1e6) : Date.now());

/** Recomputes a session's cost from OTEL api_request events (authoritative per-request cost). */
function refreshCost(ctx: Ctx, sid: string) {
  const r = ctx.db.get<{ cost: number | null }>(
    "SELECT SUM(CAST(json_extract(attrs_json, '$.cost_usd') AS REAL)) cost FROM otel_events WHERE session_id = ? AND name IN ('claude_code.api_request', 'api_request')", sid,
  );
  if (r?.cost != null) {
    ctx.db.run("UPDATE sessions SET cost_usd = MAX(CASE WHEN cost_source IN ('estimate') OR cost_source IS NULL THEN 0 ELSE cost_usd END, ?), cost_source = 'otel' WHERE id = ?", r.cost, sid);
    ctx.bus.publish('floor', 'session', { id: sid });
  }
}

/** Only keep points for sessions this machine owns (or with no session yet). */
function sessionFor(ctx: Ctx, machineId: string, a: Record<string, unknown>): string | null {
  const sid = typeof a['session.id'] === 'string' ? (a['session.id'] as string) : null;
  if (!sid) return null;
  const owner = ctx.db.get<{ machine_id: string }>('SELECT machine_id FROM sessions WHERE id = ?', sid);
  return !owner || owner.machine_id === machineId ? sid : null;
}

export function otlpRoutes(ctx: Ctx) {
  const app = new Hono<{ Variables: { machineId: string } }>();
  const auth = requireMachine(ctx);

  app.post('/v1/metrics', auth, async (c) => {
    const machineId = c.get('machineId');
    const body = (await c.req.json().catch(() => null)) as { resourceMetrics?: any[] } | null;
    let n = 0;
    ctx.db.tx(() => {
      for (const rm of body?.resourceMetrics ?? []) {
        const res = attrs(rm.resource?.attributes);
        for (const sm of rm.scopeMetrics ?? []) {
          for (const m of sm.metrics ?? []) {
            const points = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? m.histogram?.dataPoints ?? [];
            for (const p of points) {
              const a = { ...res, ...attrs(p.attributes) };
              const value = p.asDouble ?? (p.asInt !== undefined ? Number(p.asInt) : p.sum ?? 0);
              ctx.db.run('INSERT INTO otel_points (ts, session_id, name, value, attrs_json) VALUES (?, ?, ?, ?, ?)', nanoToMs(p.timeUnixNano), sessionFor(ctx, machineId, a), String(m.name), Number(value), JSON.stringify(a));
              n++;
            }
          }
        }
      }
    });
    return c.json({ partialSuccess: {}, accepted: n });
  });

  app.post('/v1/logs', auth, async (c) => {
    const machineId = c.get('machineId');
    const body = (await c.req.json().catch(() => null)) as { resourceLogs?: any[] } | null;
    const touched = new Set<string>();
    const rules = rulesFor(ctx);
    let n = 0;
    ctx.db.tx(() => {
      for (const rl of body?.resourceLogs ?? []) {
        const res = attrs(rl.resource?.attributes);
        for (const sl of rl.scopeLogs ?? []) {
          for (const r of sl.logRecords ?? []) {
            const a = { ...res, ...attrs(r.attributes) };
            const name = String(a['event.name'] ?? val(r.body) ?? 'log');
            const sid = sessionFor(ctx, machineId, a);
            // prompt/response bodies are only present if the user opted in; never store them
            delete a.prompt;
            Object.assign(a, redactValue(a, rules));
            ctx.db.run('INSERT INTO otel_events (ts, session_id, name, attrs_json) VALUES (?, ?, ?, ?)', nanoToMs(r.timeUnixNano ?? r.observedTimeUnixNano), sid, name.startsWith('claude_code.') ? name : `claude_code.${name}`, JSON.stringify(a));
            if (sid) touched.add(sid);
            n++;
          }
        }
      }
    });
    for (const sid of touched) refreshCost(ctx, sid);
    return c.json({ partialSuccess: {}, accepted: n });
  });

  return app;
}

// The consumption governor (SPEC §11.3). Reads the newest rate-limit sample from the statusline bridge and answers
// "may the factory start a worker now, and if not, until when should it wait".
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { DEFAULT_THRESHOLDS, evaluate, windowOf, type GovernorThresholds, type GovernorVerdict, type Usage } from '../../shared/factory.ts';

// The rules are pure and shared with `bb mcp`, which applies them to the local statusline sample when the server is away.
export { DEFAULT_THRESHOLDS, epochMs, evaluate } from '../../shared/factory.ts';

export function thresholds(ctx: Ctx): GovernorThresholds {
  const num = (key: string, fallback: number) => {
    const v = ctx.db.getSetting<unknown>(key, null);
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    fiveHourPct: num('governor_five_hour_pct', DEFAULT_THRESHOLDS.fiveHourPct),
    sevenDayPct: num('governor_seven_day_pct', DEFAULT_THRESHOLDS.sevenDayPct),
    maxAgeMin: num('governor_max_age_min', DEFAULT_THRESHOLDS.maxAgeMin),
  };
}

const SAMPLES = "FROM otel_points WHERE name = 'statusline.rate_limits'";

/**
 * Each window comes from the newest sample that carries it, so a sparse sample (one window, or none) cannot hide a
 * window that is still over its limit; a window whose reset time has passed is ignored later by evaluate().
 * The data's age is the newest sample's.
 */
export function readUsage(ctx: Ctx, now = Date.now()): Usage {
  const row = ctx.db.get<{ ts: number; session_id: string | null }>(`SELECT ts, session_id ${SAMPLES} ORDER BY ts DESC, id DESC LIMIT 1`);
  if (!row) return { fiveHour: null, sevenDay: null, updatedAt: null, ageMs: null, sessionId: null };
  const latest = (key: 'five_hour' | 'seven_day') => {
    const r = ctx.db.get<{ attrs_json: string }>(
      `SELECT attrs_json ${SAMPLES} AND ts > ? AND json_extract(attrs_json, '$.${key}.used_percentage') IS NOT NULL ORDER BY ts DESC, id DESC LIMIT 1`,
      now - 8 * 24 * 3600_000,
    );
    return windowOf((json<Record<string, unknown>>(r?.attrs_json, {}) ?? {})[key]);
  };
  return { fiveHour: latest('five_hour'), sevenDay: latest('seven_day'), updatedAt: row.ts, ageMs: Math.max(0, now - row.ts), sessionId: row.session_id };
}

export function governor(ctx: Ctx, now = Date.now()): GovernorVerdict {
  return evaluate(readUsage(ctx, now), thresholds(ctx), now);
}

/** One start on stale usage data per this interval: the started session's statusline refreshes the data meanwhile. */
export const STALE_START_EVERY_MS = 30 * 60_000;
/** A window counts as safe on stale data when its last known percentage is at least this many points under its limit. */
export const STALE_MARGIN_PCT = 10;

/**
 * The governor for a scheduled start (§11.8), and only for one. At night no Claude session feeds the statusline, so the
 * data is always older than maxAgeMin. When that is the only reason for canStart: false, the start is allowed if, for
 * each window, its reset time has passed since the last sample or its last known percentage is at least 10 points
 * under its limit; a window missing from the data counts as unknown and keeps today's rule. At most one such start per
 * 30 minutes (`lastStaleStart`), so the started session refreshes the data before anything else starts.
 */
export function evaluateScheduled(usage: Usage, t: GovernorThresholds, now: number, lastStaleStart: number | null): GovernorVerdict {
  const v = evaluate(usage, t, now);
  if (v.canStart || v.stopAll || usage.updatedAt === null || usage.ageMs === null || usage.ageMs <= t.maxAgeMin * 60_000) return v;
  // the windows evaluate() did not block on: a blocking window means the data is not the only reason
  const why: string[] = [];
  for (const [name, w, limit] of [['5-hour', usage.fiveHour, t.fiveHourPct], ['7-day', usage.sevenDay, t.sevenDayPct]] as const) {
    if (!w) return v;
    if (w.resetsAt !== null && w.resetsAt <= now) why.push(`${name} window reset at ${new Date(w.resetsAt).toISOString()}`);
    else if (w.pct <= limit - STALE_MARGIN_PCT) why.push(`${name} ${Math.round(w.pct)}% (limit ${limit}%)`);
    else return v;
  }
  const age = `usage data is ${Math.round(usage.ageMs / 60_000)} min old`;
  if (lastStaleStart !== null && now - lastStaleStart < STALE_START_EVERY_MS) {
    const next = lastStaleStart + STALE_START_EVERY_MS;
    return { ...v, waitUntil: next, reason: `${age} and a scheduled start on stale data ran ${Math.round((now - lastStaleStart) / 60_000)} min ago: waiting for fresh data (one such start per ${STALE_START_EVERY_MS / 60_000} min)` };
  }
  return { ...v, canStart: true, waitUntil: null, reason: `started on stale usage data: ${age}; last known ${why.join(', ')}` };
}

/** governor() for a scheduled start: the last stale start comes from scheduled_launches. */
export function scheduledGovernor(ctx: Ctx, now = Date.now()): GovernorVerdict {
  const last = ctx.db.get<{ t: number | null }>("SELECT MAX(updated_at) t FROM scheduled_launches WHERE stale_start = 1 AND status IN ('starting', 'started')")?.t ?? null;
  return evaluateScheduled(readUsage(ctx, now), thresholds(ctx), now, last);
}

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

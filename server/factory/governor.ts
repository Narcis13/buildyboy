// The consumption governor (SPEC §11.3). Reads the newest rate-limit sample from the statusline bridge and answers
// "may the factory start a worker now, and if not, until when should it wait".
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import type { GovernorThresholds, GovernorVerdict, Usage, UsageWindow } from '../../shared/factory.ts';

export const DEFAULT_THRESHOLDS: GovernorThresholds = { fiveHourPct: 85, sevenDayPct: 80, maxAgeMin: 30 };

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

/** resets_at is Unix epoch seconds in the statusline JSON; accept ms and ISO strings too. */
export function epochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return epochMs(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function windowOf(raw: unknown): UsageWindow | null {
  const w = raw as { used_percentage?: unknown; resets_at?: unknown } | null | undefined;
  if (!w || typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) return null;
  return { pct: w.used_percentage, resetsAt: epochMs(w.resets_at) };
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

const fmt = (ms: number | null) => (ms ? new Date(ms).toISOString() : 'an unknown time');

/**
 * Pure decision. Rules (fabrica.md): the 7-day window at or above its threshold stops the factory until it resets;
 * the 5-hour window at or above its threshold blocks new workers until it resets; a window missing from the data,
 * or whose reset time has passed, is ignored; data older than maxAgeMin (or no data at all) blocks new workers.
 */
export function evaluate(usage: Usage, t: GovernorThresholds, now = Date.now()): GovernorVerdict {
  const reasons: string[] = [];
  let canStart = true;
  let stopAll = false;
  let waitUntil: number | null = null;
  const later = (ms: number | null) => {
    if (ms && (waitUntil === null || ms > waitUntil)) waitUntil = ms;
  };
  const live = (w: UsageWindow | null) => (w && (w.resetsAt === null || w.resetsAt > now) ? w : null);

  const week = live(usage.sevenDay);
  if (week && week.pct >= t.sevenDayPct) {
    stopAll = true;
    canStart = false;
    later(week.resetsAt);
    reasons.push(`7-day window at ${Math.round(week.pct)}% (limit ${t.sevenDayPct}%): stop the factory until it resets at ${fmt(week.resetsAt)}`);
  }
  const five = live(usage.fiveHour);
  if (five && five.pct >= t.fiveHourPct) {
    canStart = false;
    later(five.resetsAt);
    reasons.push(`5-hour window at ${Math.round(five.pct)}% (limit ${t.fiveHourPct}%): no new workers until it resets at ${fmt(five.resetsAt)}; let active ones finish`);
  }
  if (usage.updatedAt === null) {
    canStart = false;
    reasons.push('no usage data yet: turn on the statusline bridge (bb doctor shows what is missing)');
  } else if (usage.ageMs !== null && usage.ageMs > t.maxAgeMin * 60_000) {
    canStart = false;
    reasons.push(`usage data is ${Math.round(usage.ageMs / 60_000)} min old (limit ${t.maxAgeMin} min): no new workers until fresh data arrives`);
  }
  if (!reasons.length) {
    const parts = [five ? `5-hour ${Math.round(five.pct)}%` : '5-hour window absent', week ? `7-day ${Math.round(week.pct)}%` : '7-day window absent'];
    reasons.push(`ok: ${parts.join(', ')}`);
  }
  return { canStart, stopAll, waitUntil, reason: reasons.join('; '), usage, thresholds: t };
}

export function governor(ctx: Ctx, now = Date.now()): GovernorVerdict {
  return evaluate(readUsage(ctx, now), thresholds(ctx), now);
}

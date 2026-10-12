// Smart watchers (SPEC §5.8). Server-side rules, each toggleable in settings.watchers. Each one writes a timeline
// event (deduplicated by a deterministic hash, so it fires once per condition) and can push a notification.
import type { Ctx, Notification } from './context.ts';
import { STALE_AFTER_MS } from './ingest/status.ts';

export type WatcherKind = 'stale' | 'loop' | 'budget' | 'context' | 'harness';

function enabled(ctx: Ctx, kind: WatcherKind): boolean {
  return ctx.db.getSetting<Record<string, boolean>>('watchers', {})[kind] !== false;
}

/** Records a watcher event once per `key`. Returns true when it was new. */
function fire(ctx: Ctx, sid: string, kind: WatcherKind, key: string, summary: string, notify: Notification['type'] | null) {
  const r = ctx.db.run(
    'INSERT OR IGNORE INTO events (hash, session_id, ts, event, summary, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
    `watcher:${kind}:${sid}:${key}`, sid, Date.now(), 'Watcher', summary, JSON.stringify({ watcher: kind, key }),
  );
  if (!r.changes) return false;
  ctx.bus.publish(`session:${sid}`, 'timeline');
  ctx.bus.publish('floor', 'session', { id: sid });
  if (notify) {
    const s = ctx.db.get<{ name: string | null; project: string | null }>('SELECT s.name, p.name AS project FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?', sid);
    ctx.notify({ type: notify, title: summary, body: [s?.project, s?.name].filter(Boolean).join(' · ') || sid.slice(0, 8), sessionId: sid, url: `/s/${sid}` });
  }
  return true;
}

export function runWatchers(ctx: Ctx, now = Date.now()) {
  const { db } = ctx;
  const live = db.all<{ id: string; status: string; last_event_at: number; cost_usd: number; context_pct: number | null; compactions: number; job_id: string | null }>(
    "SELECT id, status, last_event_at, cost_usd, context_pct, compactions, job_id FROM sessions WHERE status != 'ended' AND last_event_at > ?", now - 48 * 3600_000,
  );

  for (const s of live) {
    // stale: no event for 10 min while working
    if (enabled(ctx, 'stale') && (s.status === 'working' || s.status === 'stale') && now - s.last_event_at > STALE_AFTER_MS) {
      if (s.status === 'working') db.run("UPDATE sessions SET status = 'stale' WHERE id = ?", s.id);
      fire(ctx, s.id, 'stale', String(s.last_event_at), 'No events for 10 minutes while working (stale)', 'stale');
    }

    if (enabled(ctx, 'loop')) {
      // the same tool + input failing 3+ times
      const loops = db.all<{ tool_name: string; command: string | null; n: number; last: number }>(
        `SELECT tool_name, command, COUNT(*) n, MAX(started_at) last FROM tool_calls WHERE session_id = ? AND status = 'error' AND started_at > ?
         GROUP BY tool_name, input_json HAVING COUNT(*) >= 3`, s.id, now - 6 * 3600_000,
      );
      for (const l of loops) fire(ctx, s.id, 'loop', `${l.tool_name}:${l.command ?? ''}`, `Loop suspicion: ${l.tool_name}${l.command ? ` “${l.command.slice(0, 60)}”` : ''} failed ${l.n} times`, 'loop');
      // 15+ turns without file changes
      const lastChange = db.get<{ ts: number | null }>('SELECT MAX(ts) ts FROM file_changes WHERE session_id = ?', s.id)?.ts ?? 0;
      const turns = db.get<{ n: number }>("SELECT COUNT(*) n FROM events WHERE session_id = ? AND event = 'Stop' AND ts > ?", s.id, lastChange)!.n;
      if (turns >= 15) fire(ctx, s.id, 'loop', `turns:${lastChange}`, `Loop suspicion: ${turns} turns without file changes`, 'loop');
    }

    if (enabled(ctx, 'budget')) {
      const limit = db.getSetting<number | null>('budget_session_usd', null);
      if (limit && s.cost_usd > limit) fire(ctx, s.id, 'budget', String(limit), `Session cost passed $${limit} ($${s.cost_usd.toFixed(2)})`, 'budget');
      if (s.job_id) {
        const job = db.get<{ options_json: string; started_at: number | null }>('SELECT options_json, started_at FROM jobs WHERE id = ?', s.job_id);
        const opts = job ? (JSON.parse(job.options_json) as { maxBudgetUsd?: number; limitMinutes?: number }) : {};
        const jobLimit = db.getSetting<number | null>('budget_job_usd', null) ?? opts.maxBudgetUsd ?? null;
        if (jobLimit && s.cost_usd >= jobLimit * 0.9) fire(ctx, s.id, 'budget', `job:${jobLimit}`, `Job is at ${Math.round((s.cost_usd / jobLimit) * 100)}% of its $${jobLimit} budget`, 'budget');
        if (enabled(ctx, 'harness') && opts.limitMinutes && job?.started_at && now > job.started_at + opts.limitMinutes * 60_000) {
          fire(ctx, s.id, 'harness', 'limit', `Run reached its Limit (${opts.limitMinutes} min)`, 'budget');
        }
      }
    }

    if (enabled(ctx, 'context')) {
      const pct = db.getSetting<number>('context_threshold_pct', 85);
      if (s.context_pct != null && s.context_pct > pct) fire(ctx, s.id, 'context', `pct:${pct}`, `Context ${Math.round(s.context_pct)}% used`, 'context');
      if (s.compactions >= 3) fire(ctx, s.id, 'context', `compactions:${s.compactions}`, `${s.compactions} compactions in this session`, 'context');
    }

    if (enabled(ctx, 'harness') && s.status !== 'idle') {
      // PROGRESS.md "Next" unchanged for 60 min
      const docs = db.all<{ ts: number; content: string }>('SELECT ts, content FROM progress_docs WHERE session_id = ? ORDER BY ts DESC LIMIT 20', s.id);
      if (docs.length) {
        const next = nextSection(docs[0].content);
        let since = docs[0].ts;
        for (const d of docs.slice(1)) {
          if (nextSection(d.content) !== next) break;
          since = d.ts;
        }
        if (next && now - since > 60 * 60_000) fire(ctx, s.id, 'harness', `next:${since}`, 'PROGRESS.md “Next” has not changed in 60 minutes', 'loop');
      }
    }
  }
}

/** The body of the `## Next` section (or a `- **Next:** …` bullet) of a PROGRESS.md. */
export function nextSection(md: string): string {
  const out: string[] = [];
  let inside = false;
  for (const l of md.split(/\r?\n/)) {
    const bullet = /^\s*[-*]?\s*\*\*Next:?\*\*:?\s*(.*)$/i.exec(l);
    if (/^#+\s*Next\b/i.test(l) || bullet) {
      inside = true;
      if (bullet?.[1]) out.push(bullet[1]);
      continue;
    }
    if (inside && (/^#+\s/.test(l) || /^\s*[-*]?\s*\*\*[\w ]+:?\*\*/.test(l))) break;
    if (inside) out.push(l);
  }
  return out.join('\n').trim();
}

/** Rate limits above 80% (from the statusline bridge): one notification per window and limit. */
export function checkRateLimits(ctx: Ctx, sid: string, limits: Record<string, { used_percentage?: number; resets_at?: string | number }> | null | undefined) {
  if (!limits || !enabled(ctx, 'budget')) return;
  for (const [name, l] of Object.entries(limits)) {
    if (typeof l?.used_percentage === 'number' && l.used_percentage > 80) {
      fire(ctx, sid, 'budget', `rate:${name}:${l.resets_at ?? ''}`, `Rate limit ${name.replace('_', ' ')} at ${Math.round(l.used_percentage)}%`, 'budget');
    }
  }
}

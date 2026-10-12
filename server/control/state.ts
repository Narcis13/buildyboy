import type { Ctx } from '../context.ts';
import type { ControlState, SessionControl } from '../../shared/types.ts';

export function globalWalk(ctx: Ctx): boolean {
  return ctx.db.getSetting<boolean>('walk_mode', false);
}

export function machineWalk(ctx: Ctx, machineId: string): boolean {
  const m = ctx.db.get<{ walk_mode: number | null }>('SELECT walk_mode FROM machines WHERE id = ?', machineId);
  if (m && m.walk_mode != null) return m.walk_mode === 1;
  return globalWalk(ctx);
}

/** Effective walk mode: session setting, else machine, else global. */
export function sessionWalk(ctx: Ctx, sessionId: string): boolean {
  const s = ctx.db.get<{ walk_mode: number | null; machine_id: string }>('SELECT walk_mode, machine_id FROM sessions WHERE id = ?', sessionId);
  if (!s) return globalWalk(ctx);
  if (s.walk_mode != null) return s.walk_mode === 1;
  return machineWalk(ctx, s.machine_id);
}

export function pauseAll(ctx: Ctx): boolean {
  return ctx.db.getSetting<boolean>('pause_all', false);
}

/** The control cache returned to hooks on every call (written to ~/.buildyboy/control.json). */
export function controlStateFor(ctx: Ctx, machineId: string): ControlState {
  const walk = machineWalk(ctx, machineId);
  const since = Date.now() - 24 * 3600 * 1000;
  const rows = ctx.db.all<{ id: string; walk_mode: number | null; kill_requested: number; paused: number; queued: number }>(
    `SELECT s.id, s.walk_mode, s.kill_requested, s.paused,
       (SELECT COUNT(*) FROM queued_messages q WHERE q.session_id = s.id AND q.status = 'queued') AS queued
     FROM sessions s WHERE s.machine_id = ? AND s.last_event_at > ? AND s.status != 'ended'`,
    machineId, since,
  );
  const sessions: Record<string, SessionControl> = {};
  for (const r of rows) {
    if (r.walk_mode == null && !r.kill_requested && !r.paused && !r.queued) continue;
    const c: SessionControl = { walk: r.walk_mode == null ? walk : r.walk_mode === 1 };
    if (r.kill_requested) c.kill = true;
    if (r.paused) c.pause = true;
    if (r.queued) c.queued = Number(r.queued);
    sessions[r.id] = c;
  }
  const state: ControlState = { ts: Date.now(), walk, sessions };
  if (pauseAll(ctx)) state.pauseAll = true;
  return state;
}

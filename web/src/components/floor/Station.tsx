// A session drawn as a factory station: lamp, project + branch, activity, meters, conveyor belt and drones.
import type { CSSProperties, ReactNode } from 'react';
import type { SessionStatus, SessionSummary, ToolToken } from '../../../../shared/types.ts';
import { duration, toolColor, usd } from '../../lib/format.ts';
import { Lamp, statusLabel } from '../ui.tsx';
import { useLeaving } from './hooks.ts';

export const STATUS_COLOR: Record<SessionStatus, string> = {
  working: 'var(--bb-working)',
  waiting: 'var(--bb-waiting)',
  idle: 'var(--bb-idle)',
  compacting: 'var(--bb-idle)',
  stale: 'var(--bb-waiting)',
  ended: 'var(--bb-ended)',
  error: 'var(--bb-error)',
};

/** Sort key: waiting first, then errors, then active work, then the rest. */
export const STATUS_RANK: Record<SessionStatus, number> = { waiting: 0, error: 1, working: 2, compacting: 2, stale: 3, idle: 4, ended: 5 };

export function toolShort(tool: string): string {
  if (tool.startsWith('mcp__')) return tool.split('__').slice(1).join(' › ');
  return tool;
}

/** The conveyor belt: last ~20 tool calls as colored tokens, newest on the right. */
export function Belt({ tokens, className = '' }: { tokens: ToolToken[]; className?: string }) {
  return (
    <div
      data-testid="belt"
      aria-label={`Last ${tokens.length} tool calls`}
      className={`relative flex h-7 items-center justify-end gap-[3px] overflow-hidden rounded-md border border-line px-1.5 ${className}`}
      style={{
        background:
          'repeating-linear-gradient(90deg, color-mix(in srgb, var(--bb-line) 70%, transparent) 0 1px, transparent 1px 9px), var(--bb-bg-2)',
      }}
    >
      {!tokens.length && <span className="mr-auto font-mono text-[11px] uppercase tracking-widest text-muted">belt idle</span>}
      {tokens.map((t) => {
        const bad = t.status === 'error' || t.status === 'denied' || t.status === 'interrupted';
        const c = toolColor(t.tool);
        return (
          <span
            key={t.id}
            title={`${t.tool} · ${t.status}`}
            data-tool={t.tool}
            data-status={t.status}
            className={`bb-slide-in inline-block h-4 w-3 shrink-0 rounded-[3px] ${t.status === 'running' ? 'animate-pulse' : ''}`}
            style={{
              background: bad ? `color-mix(in srgb, ${c} 35%, transparent)` : c,
              boxShadow: bad ? '0 0 0 2px var(--bb-error)' : `0 0 6px color-mix(in srgb, ${c} 45%, transparent)`,
            }}
          />
        );
      })}
    </div>
  );
}

function Meter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">{label}</div>
      <div className="truncate font-mono text-[15px] tabular-nums">{children}</div>
    </div>
  );
}

export function Tank({ pct, className = '' }: { pct: number | null; className?: string }) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const color = p >= 90 ? 'var(--bb-error)' : p >= 75 ? 'var(--bb-waiting)' : 'var(--bb-accent)';
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-bg-2 ring-1 ring-line ${className}`} role="meter" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100} aria-label="Context used">
      <div className="h-full rounded-full transition-[width]" style={{ width: `${p}%`, background: color }} />
    </div>
  );
}

function Drones({ drones, floating }: { drones: SessionSummary['drones']; floating: boolean }) {
  const list = useLeaving(drones, (d) => d.agentId);
  if (!list.length) return null;
  if (floating) {
    // hovering above the station, tethered down to it
    return (
      <div className="pointer-events-none absolute -top-12 left-16 flex gap-3" aria-label={`${drones.length} subagents running`}>
        {list.map((d) => (
          <div key={d.agentId} className={`flex flex-col items-center transition-all duration-1000 ${d.leaving ? 'translate-y-6 opacity-0' : ''}`} title={d.agentType ?? 'subagent'}>
            <span data-testid="drone" className="grid h-7 w-7 place-items-center rounded-full border border-tool-agent bg-panel text-[13px] text-tool-agent shadow-[0_0_10px_var(--bb-tool-agent)]">
              ✣
            </span>
            <span className="h-5 border-l border-dashed border-tool-agent" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
      <span className="h-px w-4 border-t border-dashed border-tool-agent" />
      {list.map((d) => (
        <span
          key={d.agentId}
          data-testid="drone"
          className={`inline-flex items-center gap-1 rounded-full border border-tool-agent/60 px-2 py-0.5 text-tool-agent transition-all duration-1000 ${d.leaving ? 'opacity-0' : ''}`}
        >
          ✣ {d.agentType ?? 'subagent'}
        </span>
      ))}
    </div>
  );
}

function JobBadge({ job, cost, now }: { job: NonNullable<SessionSummary['job']>; cost: number; now: number }) {
  const parts: string[] = [];
  if (job.deadline) parts.push(job.deadline > now ? `${duration(job.deadline - now)} left` : 'time up');
  if (job.maxBudgetUsd != null) parts.push(`${usd(Math.max(0, job.maxBudgetUsd - cost))} left`);
  return (
    <span data-testid="job-badge" className="inline-flex shrink-0 items-center gap-1 rounded border border-accent/50 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-accent" title={`Job ${job.id} · ${job.status}`}>
      job{parts.length ? <span className="normal-case tracking-normal text-ink">{parts.join(' · ')}</span> : null}
    </span>
  );
}

const corner = 'pointer-events-none absolute h-2.5 w-2.5 border-accent/60';

export function Station({ s, variant, now, replay = false }: { s: SessionSummary; variant: 'node' | 'card'; now: number; replay?: boolean }) {
  const color = STATUS_COLOR[s.status];
  const elapsed = (s.endedAt ?? now) - s.startedAt;
  const waiting = s.status === 'waiting';
  const activity = s.activity ?? (s.status === 'ended' ? 'Ended' : '—');
  const style: CSSProperties = {
    borderLeftColor: color,
    boxShadow: waiting ? '0 0 0 1px var(--bb-waiting), 0 0 28px color-mix(in srgb, var(--bb-waiting) 28%, transparent)' : undefined,
  };
  return (
    <div
      data-testid={`station-${s.id}`}
      data-status={s.status}
      className={`relative flex flex-col gap-2.5 rounded-xl border border-l-4 border-line bg-panel p-3.5 text-left ${variant === 'node' ? 'h-[232px] w-[300px]' : 'w-full'} ${s.status === 'ended' ? 'opacity-80' : ''}`}
      style={style}
    >
      <span className={`${corner} -right-px -top-px rounded-tr-xl border-r border-t`} />
      <span className={`${corner} -bottom-px -right-px rounded-br-xl border-b border-r`} />
      {variant === 'node' && <Drones drones={s.drones} floating />}
      <div className="flex items-start gap-3">
        <Lamp status={s.status} size={22} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[15px] font-semibold uppercase tracking-wider">{s.projectName ?? 'no project'}</span>
            {s.job && <JobBadge job={s.job} cost={s.costUsd} now={now} />}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[13px] text-muted">
            {s.branch ? (
              <>
                <span aria-hidden>⎇</span>
                <span className="truncate">{s.branch}</span>
                {s.dirty && <span data-testid="dirty-dot" title="Uncommitted changes" className="inline-block h-2 w-2 shrink-0 rounded-full bg-waiting" />}
              </>
            ) : (
              <span>no git</span>
            )}
          </div>
        </div>
        <span className="shrink-0 text-[12px] font-semibold uppercase tracking-wider" style={{ color }}>
          {statusLabel(s.status)}
        </span>
      </div>
      <div className="truncate text-[15px]" title={s.name ?? undefined}>
        {s.name ?? <span className="text-muted">Untitled session</span>}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[13px]" title={s.statusReason ?? activity}>
        <span style={{ color }} aria-hidden>
          ▸
        </span>
        <span className={`truncate ${waiting ? 'text-waiting' : 'text-muted'}`}>{waiting && s.statusReason ? s.statusReason : activity}</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Meter label="Context">
          {replay ? (
            '—'
          ) : (
            <div className="flex items-center gap-1.5">
              <Tank pct={s.contextPct} className="flex-1" />
              <span className="text-[13px]">{s.contextPct != null ? `${Math.round(s.contextPct)}%` : '—'}</span>
            </div>
          )}
        </Meter>
        <Meter label="Cost">{replay ? '—' : usd(s.costUsd)}</Meter>
        <Meter label="Time">{duration(elapsed)}</Meter>
      </div>
      {variant === 'card' && <Drones drones={s.drones} floating={false} />}
      <Belt tokens={s.belt} className={variant === 'node' ? 'mt-auto' : ''} />
    </div>
  );
}

// Session header: identity, git state, meters, controls and resume commands.
import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SessionDetail } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { duration, shortPath, tokens, usd } from '../../lib/format.ts';
import { Link } from '../../lib/router.tsx';
import { Badge, Button, CopyButton, Lamp, RelTime, statusLabel, Toggle } from '../ui.tsx';
import { STATUS_COLOR, Tank } from '../floor/Station.tsx';
import type { SideData } from './types.ts';

function Metric({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-bg-2/60 px-2.5 py-1.5">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">{label}</div>
      <div className="truncate font-mono text-[15px] tabular-nums">{children}</div>
      {sub && <div className="truncate font-mono text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function gitState(side: SideData | undefined, s: SessionDetail): string {
  const g = side?.git.snapshots.at(-1);
  const parts: string[] = [];
  if (g?.ahead) parts.push(`↑${g.ahead}`);
  if (g?.behind) parts.push(`↓${g.behind}`);
  if (g?.dirty) parts.push(`${g.dirty} dirty`);
  else if (s.dirty) parts.push('dirty');
  if (!parts.length && g) parts.push('clean');
  return parts.join(' ');
}

export function SessionHeader({ s, side, now, compact }: { s: SessionDetail; side?: SideData; now: number; compact: boolean }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const act = useMutation({
    mutationFn: ({ action, body }: { action: 'stop' | 'pause' | 'resume' | 'walk' | 'mute'; body?: unknown }) => api.post(`/api/sessions/${s.id}/${action}`, body ?? {}),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['session', s.id] });
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  const color = STATUS_COLOR[s.status];
  const ended = s.status === 'ended';
  const totalIn = s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite;
  const showDetails = !compact || expanded;
  const git = gitState(side, s);
  const pending = side?.pending ?? [];

  return (
    <section data-testid="session-header" className="@container rounded-xl border border-line bg-panel p-3 md:p-4" style={{ boxShadow: `inset 0 3px 0 ${color}` }}>
      <div className="flex items-start gap-3">
        <Lamp status={s.status} size={20} className="mt-1" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span data-testid="session-status" className="text-[13px] font-semibold uppercase tracking-wider" style={{ color }}>
              {statusLabel(s.status)}
            </span>
            {s.paused && <Badge color="var(--bb-waiting)">paused</Badge>}
            {s.walkMode && <Badge color="var(--bb-waiting)">walk mode</Badge>}
            {s.job && <Badge color="var(--bb-accent)">job · {s.job.status}</Badge>}
            {s.killRequested && !ended && <Badge color="var(--bb-error)">stopping</Badge>}
          </div>
          <h1 className="break-words text-lg font-semibold leading-snug md:text-xl">{s.name ?? 'Untitled session'}</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[13px] text-muted">
            <span className="text-ink">{s.projectName ?? 'no project'}</span>
            <Link to="/machines" className="hover:text-ink">
              {s.machineName}
              {s.platform ? ` (${s.platform})` : ''}
            </Link>
            {s.branch && (
              <span>
                ⎇ {s.branch}
                {git && <span className={s.dirty ? 'text-waiting' : ''}> · {git}</span>}
              </span>
            )}
            {showDetails && s.cwd && (
              <span className="break-all" title={s.cwd}>
                {shortPath(s.cwd, 3)}
              </span>
            )}
          </div>
        </div>
        {compact && (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="-mr-1 -mt-1 min-h-11 min-w-11 shrink-0 rounded-lg text-[14px] text-muted hover:text-ink">
            {expanded ? 'Less ▴' : 'More ▾'}
          </button>
        )}
      </div>

      {!showDetails && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[14px]">
          <span>{usd(s.costUsd)}</span>
          <span className="text-muted">ctx {s.contextPct != null ? `${Math.round(s.contextPct)}%` : '—'}</span>
          <span className="text-muted">{duration((s.endedAt ?? now) - s.startedAt)}</span>
          {s.waitMs > 0 && <span className="text-muted">waited {duration(s.waitMs)}</span>}
        </div>
      )}

      {pending.length > 0 && (
        <Link to="/inbox" data-testid="pending-banner" className="mt-3 flex min-h-11 items-center gap-2 rounded-lg bg-waiting/15 px-3 text-[15px] text-waiting ring-1 ring-waiting/50">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-waiting" />
          {pending.length === 1 ? `Waiting on you: ${pending[0].toolName ?? pending[0].kind}` : `${pending.length} requests waiting on you`}
          <span className="ml-auto">Answer →</span>
        </Link>
      )}

      {showDetails && (
        <>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {s.model && <Badge>{s.model}</Badge>}
            {s.effort && <Badge>effort {s.effort}</Badge>}
            {s.permissionMode && <Badge>{s.permissionMode}</Badge>}
            <Badge>{s.source}</Badge>
            {s.imported && <Badge>imported</Badge>}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 @2xl:grid-cols-3 @5xl:grid-cols-6">
            <Metric label="Cost" sub={s.linesAdded || s.linesRemoved ? `+${s.linesAdded} −${s.linesRemoved} lines` : undefined}>
              {usd(s.costUsd)}
            </Metric>
            <Metric label="Tokens in / out" sub={s.cacheHitPct != null ? `cache hit ${s.cacheHitPct}%` : undefined}>
              {tokens(totalIn)} / {tokens(s.tokens.output)}
            </Metric>
            <Metric label="Context" sub={s.compactions ? `${s.compactions} compaction${s.compactions > 1 ? 's' : ''}` : 'no compactions'}>
              <div className="flex items-center gap-2">
                <Tank pct={s.contextPct} className="flex-1" />
                <span>{s.contextPct != null ? `${Math.round(s.contextPct)}%` : '—'}</span>
              </div>
            </Metric>
            <Metric label="Duration" sub={<RelTime ts={s.startedAt} />}>
              {duration((s.endedAt ?? now) - s.startedAt)}
            </Metric>
            <Metric label="Waiting on me">{duration(s.waitMs)}</Metric>
            <Metric label="Last event" sub={s.endReason ? `ended: ${s.endReason}` : undefined}>
              <RelTime ts={s.lastEventAt} />
            </Metric>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!ended && (
              <Toggle label="Walk mode" on={s.walkMode} disabled={act.isPending} onChange={(on) => act.mutate({ action: 'walk', body: { on } })} />
            )}
            {!ended && (
              <Toggle label="Notify" on={!s.pushMuted} disabled={act.isPending} onChange={(on) => act.mutate({ action: 'mute', body: { on: !on } })} />
            )}
            {!ended &&
              (s.paused ? (
                <Button variant="ok" disabled={act.isPending} onClick={() => act.mutate({ action: 'resume' })}>
                  ▶ Resume
                </Button>
              ) : (
                <Button disabled={act.isPending} onClick={() => act.mutate({ action: 'pause' })}>
                  ❚❚ Pause
                </Button>
              ))}
            {!ended &&
              (confirmStop ? (
                <span className="inline-flex flex-wrap items-center gap-2 rounded-lg bg-error/10 p-1 ring-1 ring-error/40">
                  <span className="px-2 text-[15px]">Stop this session?</span>
                  <Button
                    variant="danger"
                    data-testid="confirm-stop"
                    onClick={() => {
                      act.mutate({ action: 'stop' });
                      setConfirmStop(false);
                    }}
                  >
                    Yes, stop
                  </Button>
                  <Button onClick={() => setConfirmStop(false)}>Cancel</Button>
                </span>
              ) : (
                <Button variant="danger" data-testid="stop" disabled={s.killRequested} onClick={() => setConfirmStop(true)}>
                  ■ Stop
                </Button>
              ))}
            {s.remoteControl && (
              <a href={s.remoteControl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-lg border border-accent/60 px-4 text-[15px] text-accent hover:bg-accent/10">
                Remote Control ↗
              </a>
            )}
            <a href={`/api/sessions/${s.id}/export.md`} data-testid="export" className="inline-flex min-h-11 items-center rounded-lg border border-line bg-panel-2 px-4 text-[15px] hover:border-accent">
              Export .md
            </a>
            {act.isError && <span className="text-[14px] text-error">{(act.error as Error).message}</span>}
          </div>

          <div className="mt-3 grid gap-1.5 @5xl:grid-cols-3">
            {[
              ['Resume', `claude --resume ${s.id}`],
              ['Desktop', `claude --desktop --resume ${s.id}`],
              ['Go to', s.cwd ? `cd ${s.cwd.includes(' ') ? `"${s.cwd}"` : s.cwd}` : null],
            ]
              .filter((c): c is [string, string] => !!c[1])
              .map(([label, cmd]) => (
                <div key={label} className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-bg-2/60 py-1 pl-2.5 pr-1">
                  <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={cmd}>
                    {cmd}
                  </code>
                  <CopyButton text={cmd} label="Copy" className="min-h-11 shrink-0" />
                </div>
              ))}
          </div>
        </>
      )}
    </section>
  );
}

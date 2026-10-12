// Replay: scrub through the session; the timeline shows items up to the scrubbed time and a station re-animates.
import { useEffect, useMemo, useState } from 'react';
import type { SessionDetail, SessionStatus, SessionSummary, TimelineItem } from '../../../../shared/types.ts';
import { duration, exactTime, shortPath } from '../../lib/format.ts';
import { Button, Lamp } from '../ui.tsx';
import { Belt, Station } from '../floor/Station.tsx';
import type { SideData } from './types.ts';

function activityOf(i: Extract<TimelineItem, { kind: 'tool' }>): string {
  if (i.tool === 'Bash') return `Bash: ${i.command ?? ''}`;
  if (['Edit', 'Write', 'MultiEdit'].includes(i.tool)) return `Editing ${shortPath(i.filePath, 2)}`;
  if (i.tool === 'Read') return `Reading ${shortPath(i.filePath, 2)}`;
  return i.tool;
}

export function replaySummary(s: SessionDetail, items: TimelineItem[], subagents: SideData['subagents'], t: number): SessionSummary {
  const past = items.filter((i) => i.ts <= t);
  const tools = past.filter((i): i is Extract<TimelineItem, { kind: 'tool' }> => i.kind === 'tool');
  const last = past[past.length - 1];
  const end = s.endedAt ?? s.lastEventAt;
  let status: SessionStatus = 'working';
  if (t >= end) status = s.status;
  else if (last?.kind === 'event') {
    if (last.event === 'Stop') status = 'idle';
    else if (last.event === 'StopFailure') status = 'error';
    else if (last.event === 'SessionEnd') status = 'ended';
    else if (last.event === 'PreCompact') status = 'compacting';
    else if (last.level === 'warn' && (last.event === 'PermissionRequest' || last.event === 'Notification')) status = 'waiting';
  }
  const lastTool = tools[tools.length - 1];
  return {
    ...s,
    status,
    statusReason: status === 'waiting' && last?.kind === 'event' ? last.summary : null,
    activity: lastTool ? activityOf(lastTool) : null,
    endedAt: t,
    belt: tools.slice(-20).map((i) => ({
      id: i.id,
      tool: i.tool,
      status: i.durationMs != null && i.ts + i.durationMs > t ? 'running' : i.status,
    })),
    drones: subagents.filter((a) => a.startedAt <= t && (a.endedAt == null || a.endedAt > t)).map((a) => ({ agentId: a.agentId, agentType: a.agentType })),
  };
}

export function ReplayBar({ s, items, subagents, t, setT, onExit }: {
  s: SessionDetail;
  items: TimelineItem[];
  subagents: SideData['subagents'];
  t: number;
  setT: (t: number) => void;
  onExit: () => void;
}) {
  const start = s.startedAt;
  const end = Math.max(s.endedAt ?? s.lastEventAt, items[items.length - 1]?.ts ?? 0, start + 1000);
  const [playing, setPlaying] = useState(false);
  const times = useMemo(() => [...new Set(items.map((i) => i.ts))].sort((a, b) => a - b), [items]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const next = times.find((x) => x > t);
      if (next == null) {
        setT(end);
        setPlaying(false);
      } else setT(next);
    }, 450);
    return () => clearInterval(timer);
  }, [playing, t, times, end, setT]);

  const summary = useMemo(() => replaySummary(s, items, subagents, t), [s, items, subagents, t]);
  const shown = items.filter((i) => i.ts <= t).length;

  return (
    <div data-testid="replay" className="shrink-0 rounded-xl border border-accent/50 bg-panel p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Replay</span>
        <Button
          size="sm"
          className="min-h-11 min-w-11"
          aria-label={playing ? 'Pause replay' : 'Play replay'}
          onClick={() => {
            if (!playing && t >= end) setT(start);
            setPlaying(!playing);
          }}
        >
          {playing ? '❚❚' : '▶'}
        </Button>
        <span className="font-mono text-[13px] tabular-nums" title={exactTime(t)}>
          +{duration(t - start)} · {shown}/{items.length}
        </span>
        <Button size="sm" className="ml-auto min-h-11" onClick={onExit}>
          Exit replay
        </Button>
      </div>
      <input
        type="range"
        aria-label="Replay position"
        data-testid="replay-scrubber"
        min={start}
        max={end}
        step="any"
        value={t}
        onChange={(e) => {
          setPlaying(false);
          setT(Number(e.target.value));
        }}
        className="my-1 h-11 w-full cursor-pointer accent-[var(--bb-accent)]"
      />
      <div className="hidden max-w-md md:block">
        <Station s={summary} variant="card" now={t} replay />
      </div>
      <div className="flex items-center gap-2 md:hidden">
        <Lamp status={summary.status} size={16} />
        <Belt tokens={summary.belt} className="min-w-0 flex-1" />
      </div>
    </div>
  );
}

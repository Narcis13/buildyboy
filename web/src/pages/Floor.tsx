import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MachineSummary, SessionStatus, SessionSummary } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { Empty } from '../components/ui.tsx';
import { FloorCanvas, type Bay } from '../components/floor/FloorCanvas.tsx';
import { FloorList } from '../components/floor/FloorList.tsx';
import { STATUS_COLOR, STATUS_RANK } from '../components/floor/Station.tsx';
import { isPhoneQuery, readStore, useMedia, writeStore } from '../components/floor/hooks.ts';

type Scope = 'live' | 'today' | 'all';
interface Filters {
  scope: Scope;
  project: string;
  machine: string;
}
const FILTERS = 'bb-floor-filters-v1';
const DEFAULT: Filters = { scope: 'today', project: '', machine: '' };

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 rounded-lg border border-line bg-panel p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={`min-h-10 rounded-md px-3 text-[15px] ${value === o.id ? 'bg-panel-2 text-ink shadow-[inset_0_-2px_0_var(--bb-accent)]' : 'text-muted hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const selectCls = 'min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-panel px-2 text-[15px] text-ink sm:flex-none sm:w-44';

export default function Floor() {
  const [f, setF] = useState<Filters>(() => ({ ...DEFAULT, ...readStore<Partial<Filters>>(FILTERS, {}) }));
  const update = (patch: Partial<Filters>) => {
    const next = { ...f, ...patch };
    setF(next);
    writeStore(FILTERS, next);
  };
  const isPhone = useMedia(isPhoneQuery);
  const [view, setView] = useState<'list' | 'canvas' | null>(null);
  const mode = view ?? (isPhone ? 'list' : 'canvas');

  const since = f.scope === 'today' ? startOfToday() : undefined;
  const qs = new URLSearchParams();
  if (f.scope === 'live') qs.set('live', '1');
  if (since) qs.set('since', String(since));
  if (f.project) qs.set('project', f.project);
  if (f.machine) qs.set('machine', f.machine);

  const sessions = useQuery({
    queryKey: ['sessions', 'floor', f.scope, since ?? 0, f.project, f.machine],
    queryFn: () => api.get<SessionSummary[]>(`/api/sessions?${qs}`),
    refetchInterval: 30_000,
  });
  const machines = useQuery({ queryKey: ['machines'], queryFn: () => api.get<MachineSummary[]>('/api/machines') });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ id: number; name: string; machineName: string }[]>('/api/projects') });

  const bays = useMemo<Bay[]>(() => {
    const byId = new Map((machines.data ?? []).map((m) => [m.id, m]));
    const groups = new Map<string, Bay>();
    for (const s of sessions.data ?? []) {
      let b = groups.get(s.machineId);
      if (!b) groups.set(s.machineId, (b = { id: s.machineId, name: s.machineName, machine: byId.get(s.machineId) ?? null, sessions: [] }));
      b.sessions.push(s);
    }
    const best = (b: Bay) => Math.min(...b.sessions.map((s) => STATUS_RANK[s.status]));
    return [...groups.values()].sort((a, b) => best(a) - best(b) || a.name.localeCompare(b.name));
  }, [sessions.data, machines.data]);

  const counts = useMemo(() => {
    const c: Partial<Record<SessionStatus, number>> = {};
    for (const s of sessions.data ?? []) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [sessions.data]);

  return (
    <div data-testid="floor" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="font-mono text-lg font-semibold uppercase tracking-[0.3em]">Floor</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[13px] text-muted">
          {(['waiting', 'working', 'error', 'stale', 'idle', 'ended'] as SessionStatus[])
            .filter((s) => counts[s])
            .map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[s] }} />
                {counts[s]} {s}
              </span>
            ))}
        </div>
        <div className="ml-auto">
          <Segmented
            label="View"
            value={mode}
            onChange={setView}
            options={[
              { id: 'list', label: 'List' },
              { id: 'canvas', label: 'Canvas' },
            ]}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-label="Filters">
        <Segmented
          label="Time range"
          value={f.scope}
          onChange={(scope) => update({ scope })}
          options={[
            { id: 'live', label: 'Live' },
            { id: 'today', label: 'Today' },
            { id: 'all', label: 'All' },
          ]}
        />
        <div className="flex w-full min-w-0 gap-2 sm:w-auto">
          <select aria-label="Project" className={selectCls} value={f.project} onChange={(e) => update({ project: e.target.value })}>
            <option value="">All projects</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.machineName}
              </option>
            ))}
          </select>
          <select aria-label="Machine" className={selectCls} value={f.machine} onChange={(e) => update({ machine: e.target.value })}>
            <option value="">All machines</option>
            {machines.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {sessions.isLoading ? (
        <div className="bb-grid h-64 animate-pulse rounded-2xl border border-line" />
      ) : sessions.isError ? (
        <Empty>Couldn't load sessions: {String((sessions.error as Error).message)}</Empty>
      ) : !bays.length ? (
        <Empty>
          No sessions {f.scope === 'live' ? 'running' : f.scope === 'today' ? 'today' : 'yet'}
          {f.project || f.machine ? ' for these filters' : ''}. Start Claude Code on a paired machine and it shows up here.
        </Empty>
      ) : mode === 'list' ? (
        <FloorList bays={bays} />
      ) : (
        <div data-testid="floor-canvas" className={`bb-grid overflow-hidden rounded-2xl border border-line ${isPhone ? 'h-[calc(100dvh-340px)] min-h-[380px]' : 'h-[calc(100dvh-210px)] min-h-[480px]'}`}>
          <FloorCanvas bays={bays} narrow={isPhone} />
        </div>
      )}
    </div>
  );
}

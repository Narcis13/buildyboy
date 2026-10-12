import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { SessionDetail, TimelineItem, TimelinePage } from '../../../shared/types.ts';
import { api, ApiError } from '../lib/api.ts';
import { Link } from '../lib/router.tsx';
import { Empty, Tabs } from '../components/ui.tsx';
import { isPhoneQuery, useMedia, useNow } from '../components/floor/hooks.ts';
import { Timeline } from '../components/timeline/Timeline.tsx';
import type { SubagentRef, TimelineCtx, ToolItem } from '../components/timeline/ToolCard.tsx';
import { SessionHeader } from '../components/session/SessionHeader.tsx';
import { SIDE_TABS, SidePanel, type SideTab } from '../components/session/SidePanels.tsx';
import { Compose } from '../components/session/Compose.tsx';
import { ReplayBar } from '../components/session/Replay.tsx';
import type { SideData } from '../components/session/types.ts';

type Lane = 'main' | 'all' | string;

/** Height from this element's top to the bottom of the viewport (above the phone nav). */
function useFillHeight(ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const calc = () => {
      const el = ref.current;
      if (!el) return;
      const nav = document.querySelector<HTMLElement>('nav[aria-label="Main"]');
      // the phone nav is position:fixed, so check its display rather than offsetParent
      const navH = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect().height : 0;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const next = Math.max(440, Math.floor(window.innerHeight - top - navH - 12));
      setH((p) => (p === next ? p : next));
    };
    calc();
    const t = setInterval(calc, 500);
    window.addEventListener('resize', calc);
    return () => {
      clearInterval(t);
      window.removeEventListener('resize', calc);
    };
  }, [ready]);
  return [ref, h] as const;
}

function LaneBar({ lane, setLane, subagents, counts, replay, toggleReplay, live }: {
  lane: Lane;
  setLane: (l: Lane) => void;
  subagents: SideData['subagents'];
  counts: Map<string, number>;
  replay: boolean;
  toggleReplay: () => void;
  live: boolean;
}) {
  const chip = (id: Lane, label: string, testId?: string) => (
    <button
      key={id}
      type="button"
      data-testid={testId}
      aria-pressed={lane === id}
      onClick={() => setLane(id)}
      className={`min-h-11 shrink-0 rounded-full border px-3.5 text-[14px] ${lane === id ? 'border-accent bg-accent/10 text-ink' : 'border-line text-muted hover:text-ink'}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex shrink-0 items-center gap-2">
      <div className="-mx-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1" role="group" aria-label="Lanes">
        {chip('main', 'Main')}
        {subagents.length > 0 && chip('all', 'All')}
        {subagents.map((a) => chip(a.agentId, `✣ ${a.agentType ?? 'subagent'} · ${counts.get(a.agentId) ?? 0}`, `lane-${a.agentId}`))}
      </div>
      {live && (
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12px] uppercase tracking-wider text-working">
          <span className="h-2 w-2 animate-pulse rounded-full bg-working" /> live
        </span>
      )}
      <button
        type="button"
        data-testid="replay-toggle"
        aria-pressed={replay}
        onClick={toggleReplay}
        className={`min-h-11 shrink-0 rounded-lg border px-3 text-[14px] ${replay ? 'border-accent text-accent' : 'border-line text-muted hover:text-ink'}`}
      >
        ⟲ Replay
      </button>
    </div>
  );
}

export default function Session({ id }: { id: string }) {
  const isPhone = useMedia(isPhoneQuery);
  const now = useNow(1000);
  const [lane, setLane] = useState<Lane>('main');
  const [phoneTab, setPhoneTab] = useState<'timeline' | SideTab>('timeline');
  const [sideTab, setSideTab] = useState<SideTab>('todos');
  const [replayT, setReplayT] = useState<number | null>(null);

  const detail = useQuery({ queryKey: ['session', id], queryFn: () => api.get<SessionDetail>(`/api/sessions/${id}`) });
  const [ref, height] = useFillHeight(!!detail.data);
  const side = useQuery({ queryKey: ['session', id, 'side'], queryFn: () => api.get<SideData>(`/api/sessions/${id}/side`) });
  const tl = useInfiniteQuery({
    queryKey: ['session', id, 'timeline'],
    queryFn: ({ pageParam }) => api.get<TimelinePage>(`/api/sessions/${id}/timeline${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.cursor ?? undefined,
  });

  const all = useMemo<TimelineItem[]>(() => {
    const seen = new Set<string>();
    const out: TimelineItem[] = [];
    for (const p of [...(tl.data?.pages ?? [])].reverse()) for (const i of p.items) if (!seen.has(i.id) && seen.add(i.id)) out.push(i);
    return out;
  }, [tl.data]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of all) if (i.agentId) m.set(i.agentId, (m.get(i.agentId) ?? 0) + 1);
    return m;
  }, [all]);

  const subagents = useMemo(() => side.data?.subagents ?? [], [side.data]);

  const laneItems = useMemo(() => {
    if (lane === 'all') return all;
    if (lane === 'main') return all.filter((i) => !i.agentId || (i.kind === 'event' && i.event.startsWith('Subagent')));
    return all.filter((i) => i.agentId === lane);
  }, [all, lane]);
  const items = useMemo(() => (replayT == null ? laneItems : laneItems.filter((i) => i.ts <= replayT)), [laneItems, replayT]);

  const openLane = useCallback(
    (agentId: string) => {
      setLane(agentId);
      setPhoneTab('timeline');
    },
    [],
  );

  const ctx = useMemo<TimelineCtx>(() => {
    const subagentFor = (item: ToolItem): SubagentRef | null => {
      const desc = typeof item.input?.description === 'string' ? item.input.description : null;
      const end = item.ts + (item.durationMs ?? 24 * 3600_000);
      const cand = subagents.filter((a) => a.startedAt >= item.ts - 2000 && a.startedAt <= end);
      const hit = cand.find((a) => desc && a.description === desc) ?? cand[0];
      return hit ? { agentId: hit.agentId, agentType: hit.agentType, description: hit.description, status: hit.status } : null;
    };
    return { cwd: detail.data?.cwd ?? null, subagentFor, laneCount: (a) => counts.get(a) ?? 0, openLane };
  }, [subagents, counts, detail.data?.cwd, openLane]);

  if (detail.isError) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <Empty>
        {notFound ? 'Session not found.' : `Couldn't load the session: ${(detail.error as Error).message}`}{' '}
        <Link to="/" className="text-accent underline">
          Back to the floor
        </Link>
      </Empty>
    );
  }
  const s = detail.data;
  if (!s) return <div className="bb-grid h-64 animate-pulse rounded-2xl border border-line" />;

  const ended = s.status === 'ended';
  const timelineCol = (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <LaneBar
        lane={lane}
        setLane={setLane}
        subagents={subagents}
        counts={counts}
        replay={replayT != null}
        toggleReplay={() => setReplayT(replayT == null ? s.startedAt : null)}
        live={s.status === 'working' && replayT == null}
      />
      {replayT != null && <ReplayBar s={s} items={all} subagents={subagents} t={replayT} setT={setReplayT} onExit={() => setReplayT(null)} />}
      {tl.isLoading ? (
        <div className="flex-1 animate-pulse rounded-xl border border-line bg-panel/50" />
      ) : (
        <Timeline
          key={`${lane}`}
          items={items}
          ctx={ctx}
          hasOlder={tl.hasNextPage && replayT == null}
          loadingOlder={tl.isFetchingNextPage}
          onLoadOlder={() => tl.fetchNextPage()}
          empty={lane === 'main' ? 'No activity yet.' : 'Nothing in this lane.'}
        />
      )}
      {replayT == null && <Compose sessionId={s.id} queued={side.data?.queued ?? []} disabled={ended} />}
    </div>
  );
  const sideProps = { side: side.data, sessionId: s.id, cwd: s.cwd, laneCount: (a: string) => counts.get(a) ?? 0, onOpenLane: openLane, now };

  return (
    <div ref={ref} data-testid="session-page" className="-mb-24 flex min-h-0 flex-col gap-2 md:-mb-8" style={{ height: height ?? undefined }}>
      {isPhone ? (
        <>
          <div className="max-h-[55%] shrink-0 overflow-y-auto">
            <SessionHeader s={s} side={side.data} now={now} compact />
          </div>
          <Tabs<'timeline' | SideTab> tabs={[{ id: 'timeline', label: 'Timeline' }, ...SIDE_TABS]} value={phoneTab} onChange={setPhoneTab} className="shrink-0" />
          <div className="min-h-0 flex-1">{phoneTab === 'timeline' ? timelineCol : <div className="h-full overflow-y-auto pb-4">{<SidePanel tab={phoneTab} {...sideProps} />}</div>}</div>
        </>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_400px] grid-rows-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
          {timelineCol}
          <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1" aria-label="Session details">
            <SessionHeader s={s} side={side.data} now={now} compact={false} />
            <div className="rounded-xl border border-line bg-panel">
              <Tabs tabs={SIDE_TABS} value={sideTab} onChange={setSideTab} className="px-2" />
              <div className="p-3">
                <SidePanel tab={sideTab} {...sideProps} />
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

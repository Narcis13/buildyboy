// Side panels: Todos, Files touched, Git, Subagents, Progress and Raw events.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.ts';
import { duration } from '../../lib/format.ts';
import { Empty, Markdown, RelTime } from '../ui.tsx';
import { Collapsible, Diff, Json } from '../timeline/parts.tsx';
import { relPath, TodoList } from '../timeline/ToolCard.tsx';
import type { RawEvent, SideData } from './types.ts';

export type SideTab = 'todos' | 'files' | 'git' | 'agents' | 'progress' | 'raw';
export const SIDE_TABS: { id: SideTab; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'files', label: 'Files' },
  { id: 'git', label: 'Git' },
  { id: 'agents', label: 'Subagents' },
  { id: 'progress', label: 'Progress' },
  { id: 'raw', label: 'Raw' },
];

const H = ({ children }: { children: string }) => <h3 className="mb-1.5 mt-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted first:mt-0">{children}</h3>;

function Todos({ side }: { side: SideData }) {
  if (!side.todos?.items.length) return <Empty>No todo list yet.</Empty>;
  const done = side.todos.items.filter((t) => t.status === 'completed').length;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-[14px] text-muted">
        <span>
          {done} of {side.todos.items.length} done
        </span>
        <RelTime ts={side.todos.ts} />
      </div>
      <TodoList todos={side.todos.items} />
    </div>
  );
}

function Files({ side, cwd }: { side: SideData; cwd: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!side.files.length) return <Empty>No files changed.</Empty>;
  const max = Math.max(...side.files.map((f) => f.edits));
  return (
    <ul data-testid="files-panel" className="flex flex-col gap-1">
      {side.files.map((f) => {
        const heat = 0.15 + 0.6 * (f.edits / max);
        const changes = side.fileChanges.filter((c) => c.path === f.path);
        return (
          <li key={f.path}>
            <button
              type="button"
              aria-expanded={open === f.path}
              onClick={() => setOpen(open === f.path ? null : f.path)}
              className="relative flex min-h-11 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-line px-2.5 text-left"
            >
              <span aria-hidden className="absolute inset-y-0 left-0" style={{ width: `${Math.round((f.edits / max) * 100)}%`, background: `color-mix(in srgb, var(--bb-tool-edit) ${Math.round(heat * 40)}%, transparent)` }} />
              <span className="relative min-w-0 flex-1 truncate font-mono text-[13px]" title={f.path}>
                {relPath(f.path, cwd)}
              </span>
              <span className="relative shrink-0 font-mono text-[12px]">
                <span className="text-working">+{f.added ?? 0}</span> <span className="text-error">−{f.removed ?? 0}</span> <span className="text-muted">×{f.edits}</span>
              </span>
            </button>
            {open === f.path && (
              <div className="mt-1 flex flex-col gap-2">
                {changes.length ? (
                  changes.map((c) => (
                    <div key={c.id}>
                      <div className="mb-0.5 flex items-center gap-2 font-mono text-[12px] text-muted">
                        {c.op} <RelTime ts={c.ts} />
                      </div>
                      {c.patch ? <Diff patch={c.patch} /> : <div className="text-[13px] text-muted">No patch recorded.</div>}
                    </div>
                  ))
                ) : (
                  <div className="text-[13px] text-muted">No per-change diffs stored.</div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Git({ side }: { side: SideData }) {
  const { snapshots, commits, prs } = side.git;
  if (!snapshots.length && !commits.length && !prs.length) return <Empty>No git info.</Empty>;
  return (
    <div data-testid="git-panel">
      {prs.length > 0 && (
        <>
          <H>Pull requests</H>
          <ul className="flex flex-col gap-1.5">
            {prs.map((p) => (
              <li key={p.number} className="rounded-lg border border-line px-2.5 py-2 text-[14px]">
                <a href={p.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  #{p.number} {p.title ?? ''}
                </a>
                <div className="font-mono text-[12px] text-muted">
                  {[p.state, p.reviewState, p.checksState && `checks ${p.checksState}`, p.branch].filter(Boolean).join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {commits.length > 0 && (
        <>
          <H>Commits</H>
          <ul className="flex flex-col gap-1.5">
            {commits.map((c) => (
              <li key={c.sha} className="rounded-lg border border-line px-2.5 py-2">
                <div className="break-words text-[15px]">{c.message}</div>
                <div className="flex flex-wrap gap-x-2 font-mono text-[12px] text-muted">
                  <span className="text-accent">{c.sha.slice(0, 7)}</span>
                  {c.files != null && <span>{c.files} files</span>}
                  <span className="text-working">+{c.added ?? 0}</span>
                  <span className="text-error">−{c.removed ?? 0}</span>
                  {c.author && <span>{c.author}</span>}
                  <RelTime ts={c.ts} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {snapshots.length > 0 && (
        <>
          <H>Snapshots</H>
          <ol className="flex flex-col gap-1 border-l border-line pl-3">
            {snapshots.map((g, i) => (
              <li key={i} className="font-mono text-[12px]">
                <span className="text-muted">{g.trigger}</span> ⎇ {g.branch ?? '?'} <span className="text-accent">{g.sha?.slice(0, 7)}</span>
                {g.ahead ? ` ↑${g.ahead}` : ''}
                {g.behind ? ` ↓${g.behind}` : ''}
                {g.dirty ? <span className="text-waiting"> {g.dirty} dirty</span> : ''}
                {g.shortstat && <div className="text-muted">{g.shortstat.trim()}</div>}
                <div className="text-muted">
                  <RelTime ts={g.ts} />
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function Agents({ side, laneCount, onOpenLane, now }: { side: SideData; laneCount: (id: string) => number; onOpenLane: (id: string) => void; now: number }) {
  if (!side.subagents.length) return <Empty>No subagents.</Empty>;
  return (
    <ul className="flex flex-col gap-2">
      {side.subagents.map((a) => {
        const running = !a.endedAt && a.status === 'running';
        return (
          <li key={a.agentId} data-testid={`subagent-${a.agentId}`} className="rounded-lg border border-line p-2.5">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${running ? 'animate-pulse bg-tool-agent' : 'bg-ended'}`} />
              <span className="font-mono text-[13px] text-tool-agent">{a.agentType ?? 'subagent'}</span>
              <span className="ml-auto font-mono text-[12px] text-muted">{running ? 'running' : a.status ?? 'done'} · {duration((a.endedAt ?? now) - a.startedAt)}</span>
            </div>
            {a.description && <div className="mt-1 break-words text-[15px]">{a.description}</div>}
            <button type="button" onClick={() => onOpenLane(a.agentId)} className="mt-1 min-h-11 text-[14px] text-accent hover:underline">
              Open lane · {laneCount(a.agentId)} items →
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Splits markdown into heading sections so Next and Decisions can be highlighted. */
function sections(md: string): { heading: string | null; text: string }[] {
  const out: { heading: string | null; text: string }[] = [{ heading: null, text: '' }];
  for (const line of md.split('\n')) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) out.push({ heading: m[1].trim(), text: `${line}\n` });
    else out[out.length - 1].text += `${line}\n`;
  }
  return out.filter((s) => s.text.trim());
}

function Progress({ side }: { side: SideData }) {
  const parts = useMemo(() => sections(side.progress?.content ?? ''), [side.progress?.content]);
  if (!side.progress) return <Empty>No PROGRESS.md seen in this session.</Empty>;
  return (
    <div data-testid="progress-panel" className="flex flex-col gap-2">
      <div className="text-[13px] text-muted">
        PROGRESS.md · <RelTime ts={side.progress.ts} />
      </div>
      {parts.map((p, i) => {
        const hot = p.heading && /^(next|decisions?)\b/i.test(p.heading);
        return hot ? (
          <div key={i} data-testid={`progress-${p.heading!.toLowerCase().split(/\s/)[0]}`} className="rounded-lg border border-accent/60 bg-accent/10 px-3 py-1">
            <Markdown text={p.text} className="text-[15px]" />
          </div>
        ) : (
          <Markdown key={i} text={p.text} className="px-1 text-[15px]" />
        );
      })}
    </div>
  );
}

function Raw({ sessionId }: { sessionId: string }) {
  const q = useQuery({ queryKey: ['session', sessionId, 'events'], queryFn: () => api.get<RawEvent[]>(`/api/sessions/${sessionId}/events?limit=500`) });
  if (q.isLoading) return <div className="text-muted">Loading…</div>;
  if (!q.data?.length) return <Empty>No events.</Empty>;
  return (
    <ul data-testid="raw-events" className="flex flex-col">
      {q.data.map((e) => (
        <li key={e.id} className="border-b border-line/60 last:border-0">
          <Collapsible
            label={
              <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 font-mono text-[12px] text-accent">{e.event}</span>
                <span className="min-w-0 truncate text-[13px]">{e.summary ?? e.toolName ?? ''}</span>
                <RelTime ts={e.ts} className="shrink-0 font-mono text-[11px]" />
              </span>
            }
          >
            <Json value={e.payload} />
          </Collapsible>
        </li>
      ))}
    </ul>
  );
}

export function SidePanel({ tab, side, sessionId, cwd, laneCount, onOpenLane, now }: {
  tab: SideTab;
  side: SideData | undefined;
  sessionId: string;
  cwd: string | null;
  laneCount: (id: string) => number;
  onOpenLane: (id: string) => void;
  now: number;
}) {
  if (tab === 'raw') return <Raw sessionId={sessionId} />;
  if (!side) return <div className="text-muted">Loading…</div>;
  if (tab === 'todos') return <Todos side={side} />;
  if (tab === 'files') return <Files side={side} cwd={cwd} />;
  if (tab === 'git') return <Git side={side} />;
  if (tab === 'agents') return <Agents side={side} laneCount={laneCount} onOpenLane={onOpenLane} now={now} />;
  return <Progress side={side} />;
}

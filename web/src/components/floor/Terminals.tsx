// herdr (hc) terminals on the Floor: one card per terminal with its agent, status, directory and links to the
// session running in it and to the backlog package it belongs to.
import type { TerminalView } from '../../../../shared/factory.ts';
import { Link } from '../../lib/router.tsx';
import { RelTime } from '../ui.tsx';

type Tone = 'working' | 'waiting' | 'idle' | 'ended' | 'error';

/** hc agent status → the app's lamp (same colours as sessions). */
const TONE: Record<string, Tone> = { working: 'working', blocked: 'waiting', idle: 'idle', done: 'ended', error: 'error' };
const RANK: Record<string, number> = { blocked: 0, error: 1, working: 2, idle: 3, done: 4 };

export const terminalTone = (t: Pick<TerminalView, 'status' | 'state'>): Tone => TONE[t.status ?? ''] ?? (t.state && t.state !== 'live' ? 'ended' : 'idle');
export const terminalStatus = (t: Pick<TerminalView, 'status' | 'state'>): string => t.status ?? (t.state && t.state !== 'live' ? t.state : 'running');

const linkCls = 'inline-flex min-h-11 items-center rounded-lg border border-line bg-panel-2 px-3 text-[15px] text-ink hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

function TerminalCard({ t, showMachine }: { t: TerminalView; showMachine: boolean }) {
  const tone = terminalTone(t);
  const status = terminalStatus(t);
  return (
    <li data-testid={`terminal-${t.address}`} data-status={status} className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-panel p-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden className={`inline-block h-3.5 w-3.5 shrink-0 bb-lamp bb-lamp-${tone}`} />
        <span className="min-w-0 flex-1 truncate font-mono text-[15px] font-semibold" title={t.name ?? t.address}>
          {t.name ?? t.address}
        </span>
        {t.name && <span className="shrink-0 font-mono text-xs text-muted">{t.address}</span>}
        <span className="shrink-0 font-mono text-xs uppercase tracking-wider" style={{ color: `var(--bb-${tone})` }}>
          {status}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs text-muted">
        <span>{t.agent ?? 'shell'}</span>
        {t.turn != null && <span>turn {t.turn}</span>}
        {showMachine && <span className="truncate">{t.machineName}</span>}
        <RelTime ts={t.seenAt} className="ml-auto" />
      </div>
      {(t.cwd || t.where) && (
        <div className="truncate font-mono text-xs text-muted" title={[t.cwd, t.where].filter(Boolean).join(' · ')}>
          {t.cwd ?? t.where}
        </div>
      )}
      {(t.sessionId || t.taskId) && (
        <div className="flex flex-wrap gap-2">
          {t.sessionId && (
            <Link to={`/s/${t.sessionId}`} className={linkCls} aria-label={`Open the session in terminal ${t.address}`}>
              Session
            </Link>
          )}
          {t.taskId && (
            <Link to={`/backlog/${t.taskId}`} className={linkCls} aria-label={`Open package ${t.taskId}`}>
              Package {t.taskId}
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

export function Terminals({ terminals }: { terminals: TerminalView[] }) {
  if (!terminals.length) return null;
  const machines = new Set(terminals.map((t) => t.machineId));
  const sorted = [...terminals].sort((a, b) => (RANK[a.status ?? ''] ?? 5) - (RANK[b.status ?? ''] ?? 5) || a.machineName.localeCompare(b.machineName) || a.address.localeCompare(b.address, undefined, { numeric: true }));
  return (
    <section data-testid="terminals" aria-label="herdr terminals" className="flex flex-col gap-2">
      <header className="flex items-center gap-2.5 border-b border-dashed border-line pb-2">
        <h2 className="font-mono text-[15px] font-semibold uppercase tracking-[0.18em]">Terminals</h2>
        <span className="font-mono text-xs text-muted">herdr</span>
        <span className="ml-auto font-mono text-xs text-muted">{terminals.length}</span>
      </header>
      <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3">
        {sorted.map((t) => (
          <TerminalCard key={`${t.machineId}/${t.address}`} t={t} showMachine={machines.size > 1} />
        ))}
      </ul>
    </section>
  );
}

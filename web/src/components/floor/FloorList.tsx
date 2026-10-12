// Phone floor: a vertical list of station cards grouped by machine, waiting sessions first.
import { Link } from '../../lib/router.tsx';
import type { Bay } from './FloorCanvas.tsx';
import { useNow } from './hooks.ts';
import { STATUS_RANK, Station } from './Station.tsx';

export function FloorList({ bays }: { bays: Bay[] }) {
  const now = useNow(1000);
  return (
    <div data-testid="floor-list" className="flex flex-col gap-6">
      {bays.map((bay) => {
        const list = [...bay.sessions].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.lastEventAt - a.lastEventAt);
        const m = bay.machine;
        return (
          <section key={bay.id} data-testid={`bay-${bay.id}`} aria-label={`Machine ${bay.name}`}>
            <header className="mb-2 flex items-center gap-2.5 border-b border-dashed border-line pb-2">
              <span
                title={m?.online ? 'Online' : 'Offline'}
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: m?.online ? 'var(--bb-working)' : 'var(--bb-ended)', boxShadow: m?.online ? '0 0 8px var(--bb-working)' : 'none' }}
              />
              <h2 className="truncate font-mono text-[15px] font-semibold uppercase tracking-[0.18em]">{bay.name}</h2>
              <span className={`shrink-0 font-mono text-[11px] uppercase tracking-wider ${m?.runnerOnline ? 'text-working' : 'text-muted'}`}>runner {m?.runnerOnline ? 'on' : 'off'}</span>
              <span className="ml-auto shrink-0 font-mono text-xs text-muted">{list.length}</span>
            </header>
            <div className="flex flex-col gap-3">
              {list.map((s) => (
                <Link key={s.id} to={`/s/${s.id}`} className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={`Open session ${s.name ?? s.id}`}>
                  <Station s={s} variant="card" now={now} />
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DecisionView } from '../../../shared/factory.ts';
import { api } from '../lib/api.ts';
import { useLocation } from '../lib/router.tsx';
import { Empty, PageTitle } from '../components/ui.tsx';
import { DecisionCard } from '../components/factory/DecisionCard.tsx';

/** Questions the coordinator could not settle alone. Pending first, then the history. */
export default function Decisions() {
  const { hash } = useLocation();
  const target = hash.slice(1);
  const { data, isLoading, error } = useQuery({ queryKey: ['decisions', 'list'], queryFn: () => api.get<DecisionView[]>('/api/decisions'), refetchInterval: 30_000 });
  const [showHistory, setShowHistory] = useState(true);
  const pending = data?.filter((d) => d.status === 'pending') ?? [];
  const history = data?.filter((d) => d.status !== 'pending') ?? [];

  // /decisions#<id> (from a push notification) scrolls to that card
  useEffect(() => {
    if (target && data?.some((d) => d.id === target)) document.getElementById(target)?.scrollIntoView({ block: 'start' });
  }, [target, data]);

  return (
    <div data-testid="decisions-page" className="mx-auto max-w-3xl">
      <PageTitle right={data && <span className="text-muted" data-testid="decisions-count">{pending.length} waiting</span>}>Decisions</PageTitle>
      {error && <div role="alert" className="mb-3 text-error">Could not load decisions: {(error as Error).message}</div>}
      {isLoading && <div className="text-muted">Loading…</div>}
      {data && !pending.length && <Empty>No question is waiting for you. The coordinator asks here when it cannot settle something alone.</Empty>}
      <div className="space-y-4" data-testid="decisions-pending">
        {pending.map((d) => (
          <DecisionCard key={d.id} d={d} highlighted={d.id === target} />
        ))}
      </div>

      {history.length > 0 && (
        <section className="mt-8" data-testid="decisions-history">
          <button className="mb-2 flex min-h-[44px] w-full items-center justify-between text-left" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>
            <h2 className="text-base font-semibold tracking-wide">
              History <span className="font-mono text-sm font-normal text-muted">{history.length}</span>
            </h2>
            <span className="text-muted">{showHistory ? '▾' : '▸'}</span>
          </button>
          {showHistory && (
            <div className="space-y-3">
              {history.map((d) => (
                <DecisionCard key={d.id} d={d} highlighted={d.id === target} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

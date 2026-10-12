import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PendingActionView } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { useLocation } from '../lib/router.tsx';
import { Card, Empty, PageTitle, Toggle } from '../components/ui.tsx';
import { ActionCard, HistoryRow } from '../components/inbox/ActionCard.tsx';

interface Inbox { pending: PendingActionView[]; history: PendingActionView[] }
interface Global { walk: boolean; pauseAll: boolean }

/** Walk mode + Pause everything, front and centre. */
function GlobalControls() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['global'], queryFn: () => api.get<Global>('/api/global') });
  const set = useMutation({
    mutationFn: ({ what, on }: { what: 'walk' | 'pause'; on: boolean }) => api.post(`/api/global/${what}`, { on }),
    onMutate: async ({ what, on }) => {
      await qc.cancelQueries({ queryKey: ['global'] });
      const prev = qc.getQueryData<Global>(['global']);
      qc.setQueryData<Global>(['global'], (g) => ({ walk: g?.walk ?? false, pauseAll: g?.pauseAll ?? false, ...(what === 'walk' ? { walk: on } : { pauseAll: on }) }));
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(['global'], ctx.prev),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['global'] });
      qc.invalidateQueries({ queryKey: ['attention'] });
    },
  });
  const walk = data?.walk ?? false;
  const pause = data?.pauseAll ?? false;
  return (
    <Card className={`mb-4 grid gap-x-6 gap-y-1 p-4 sm:grid-cols-2 ${walk ? 'border-waiting' : ''}`} data-testid="global-controls">
      <div>
        <Toggle on={walk} label="Walk mode" disabled={!data} onChange={(on) => set.mutate({ what: 'walk', on })} />
        <p className="text-sm text-muted">{walk ? 'On: permissions, questions and plans wait for you here.' : 'Off: hooks only watch; nothing waits for you.'}</p>
      </div>
      <div>
        <Toggle on={pause} label="Pause everything" disabled={!data} onChange={(on) => set.mutate({ what: 'pause', on })} />
        <p className="text-sm text-muted">{pause ? 'Every session is held at its next tool call.' : 'Holds all sessions at their next tool call.'}</p>
      </div>
    </Card>
  );
}

export default function Inbox() {
  const { hash } = useLocation();
  const target = hash.slice(1);
  const { data, isLoading, error } = useQuery({ queryKey: ['inbox'], queryFn: () => api.get<Inbox>('/api/inbox'), refetchInterval: 20_000 });
  const [showHistory, setShowHistory] = useState(true);

  // /inbox#<actionId> (from a push notification) scrolls to that card
  useEffect(() => {
    if (target && data?.pending.some((p) => p.id === target)) document.getElementById(target)?.scrollIntoView({ block: 'start' });
  }, [target, data]);

  return (
    <div data-testid="inbox-page" className="mx-auto max-w-3xl">
      <PageTitle right={data && <span className="text-muted" data-testid="inbox-count">{data.pending.length} waiting</span>}>Inbox</PageTitle>
      <GlobalControls />
      {error && <div role="alert" className="mb-3 text-error">Could not load the inbox: {(error as Error).message}</div>}
      {isLoading && <div className="text-muted">Loading…</div>}
      {data && data.pending.length === 0 && <Empty>Nothing is waiting for you. Turn on walk mode and go for a walk.</Empty>}
      <div className="space-y-4">
        {data?.pending.map((a) => <ActionCard key={a.id} action={a} highlighted={a.id === target} />)}
      </div>

      {data && data.history.length > 0 && (
        <section className="mt-8" data-testid="inbox-history">
          <button className="mb-2 flex min-h-[44px] w-full items-center justify-between text-left" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>
            <h2 className="text-base font-semibold tracking-wide">History <span className="font-mono text-sm font-normal text-muted">{data.history.length}</span></h2>
            <span className="text-muted">{showHistory ? '▾' : '▸'}</span>
          </button>
          {showHistory && <ul className="space-y-2">{data.history.map((a) => <HistoryRow key={a.id} action={a} />)}</ul>}
        </section>
      )}
    </div>
  );
}

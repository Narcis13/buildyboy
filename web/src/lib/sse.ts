// One shared EventSource for /api/stream. Messages invalidate TanStack Query keys; reconnects backfill
// from Last-Event-ID (the browser sends it automatically) and a `reset` refetches everything.
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { StreamMessage } from '../../../shared/types.ts';

type Handler = (m: StreamMessage) => void;
const handlers = new Set<Handler>();
let source: EventSource | null = null;

function connect(qc: QueryClient) {
  if (source) return;
  source = new EventSource('/api/stream?topics=*', { withCredentials: true });
  source.addEventListener('message', (ev) => {
    let m: StreamMessage;
    try {
      m = JSON.parse((ev as MessageEvent).data);
    } catch {
      return;
    }
    invalidateFor(qc, m);
    for (const h of handlers) h(m);
  });
  source.addEventListener('reset', () => qc.invalidateQueries());
  source.addEventListener('error', () => {
    // EventSource reconnects by itself; after an outage refetch once it reopens
    source?.addEventListener('open', () => qc.invalidateQueries(), { once: true });
  });
}

/** Maps a stream topic to the query keys it makes stale. */
function invalidateFor(qc: QueryClient, m: StreamMessage) {
  if (m.topic === 'floor') {
    qc.invalidateQueries({ queryKey: ['sessions'] });
    qc.invalidateQueries({ queryKey: ['attention'] });
    const id = (m.data as { id?: string } | undefined)?.id;
    if (id) qc.invalidateQueries({ queryKey: ['session', id] });
    if (m.type === 'global' || m.type === 'machines') qc.invalidateQueries({ queryKey: ['global'] });
  } else if (m.topic === 'inbox') {
    qc.invalidateQueries({ queryKey: ['inbox'] });
    qc.invalidateQueries({ queryKey: ['attention'] });
  } else if (m.topic.startsWith('session:')) {
    qc.invalidateQueries({ queryKey: ['session', m.topic.slice('session:'.length)] });
  } else if (m.topic === 'machines') {
    qc.invalidateQueries({ queryKey: ['machines'] });
  } else if (m.topic === 'jobs' || m.topic.startsWith('job:')) {
    qc.invalidateQueries({ queryKey: ['jobs'] });
    qc.invalidateQueries({ queryKey: ['attention'] });
  }
}

/** Opens the stream once logged in. */
export function useLiveStream(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    connect(qc);
    return () => {
      source?.close();
      source = null;
    };
  }, [enabled, qc]);
}

/** Subscribe to raw stream messages (e.g. for animations). */
export function useStreamMessages(fn: Handler) {
  useEffect(() => {
    handlers.add(fn);
    return () => {
      handlers.delete(fn);
    };
  }, [fn]);
}

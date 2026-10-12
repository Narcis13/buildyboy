import { Fragment, useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.ts';
import { Link, useQueryParam } from '../lib/router.tsx';
import { Badge, Card, Empty, PageTitle } from '../components/ui.tsx';

interface Hit {
  kind: 'session' | 'message' | 'command' | 'prompt' | string;
  ref: string;
  sessionId: string | null;
  snippet: string;
}

const KIND_COLOR: Record<string, string> = {
  session: 'var(--bb-accent)',
  message: 'var(--bb-tool-edit)',
  command: 'var(--bb-tool-bash)',
  prompt: 'var(--bb-tool-web)',
};

/** The server marks matches with [ ]; turn them into <mark>. */
export function Highlighted({ snippet }: { snippet: string }) {
  const parts = snippet.split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.length > 2 && p.startsWith('[') && p.endsWith(']') ? (
          <mark key={i} className="rounded bg-waiting/30 px-0.5 text-ink">{p.slice(1, -1)}</mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

function href(h: Hit): string | null {
  if (h.kind === 'prompt' && !h.sessionId) return `/composer/${encodeURIComponent(h.ref)}`;
  if (!h.sessionId) return null;
  return h.kind === 'session' ? `/s/${h.sessionId}` : `/s/${h.sessionId}#${encodeURIComponent(h.ref)}`;
}

export default function Search() {
  const initial = useQueryParam('q') ?? '';
  const [text, setText] = useState(initial);
  const [q, setQ] = useState(initial.trim());

  // debounce 250ms
  useEffect(() => {
    const t = setTimeout(() => {
      const next = text.trim();
      setQ(next);
      try {
        history.replaceState(null, '', next ? `/search?q=${encodeURIComponent(next)}` : '/search');
      } catch {
        // ignore
      }
    }, 250);
    return () => clearTimeout(t);
  }, [text]);

  const { data, isFetching, error } = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.get<Hit[]>(`/api/search?q=${encodeURIComponent(q)}`),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const hits = q ? (data ?? []) : [];

  return (
    <div data-testid="search-page">
      <PageTitle>Search</PageTitle>
      <input
        type="search"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Messages, commands, prompts, session names…"
        aria-label="Search"
        data-testid="search-input"
        className="mb-4 min-h-12 w-full rounded-xl border border-line bg-panel px-4 text-base outline-none focus:border-accent"
      />
      {error && <div role="alert" className="mb-3 text-error">Search failed: {(error as Error).message}</div>}
      {!q && <Empty>Type to search across every session, command, message and saved prompt.</Empty>}
      {q && !isFetching && hits.length === 0 && !error && <Empty>No matches for “{q}”.</Empty>}
      <ul className="space-y-2" data-testid="search-results">
        {hits.map((h, i) => {
          const to = href(h);
          const body = (
            <Card className="p-3 transition hover:border-accent">
              <div className="mb-1 flex items-center gap-2">
                <Badge color={KIND_COLOR[h.kind] ?? 'var(--bb-muted)'}>{h.kind}</Badge>
                {h.sessionId && <span className="font-mono text-sm text-muted">{h.sessionId.slice(0, 8)}</span>}
              </div>
              <p className="break-words text-[15px] leading-snug"><Highlighted snippet={h.snippet} /></p>
            </Card>
          );
          return (
            <li key={`${h.kind}:${h.ref}:${i}`} data-testid="search-hit">
              {to ? <Link to={to} className="block min-h-[44px]">{body}</Link> : body}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

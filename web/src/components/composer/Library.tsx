// Library: saved prompts with search, tags, duplicate, delete, version history and run stats.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PromptStats, PromptVersion, PromptView } from '../../../../shared/harness.ts';
import { api } from '../../lib/api.ts';
import { duration, usd } from '../../lib/format.ts';
import { navigate } from '../../lib/router.tsx';
import { Badge, Card, Empty, RelTime } from '../ui.tsx';
import { Button, errorText, inputCls } from './fields.tsx';
import { Versions } from './Versions.tsx';

export function statsLine(s: PromptStats): string {
  if (!s.runs) return 'No runs yet';
  const parts = [`${s.runs} run${s.runs === 1 ? '' : 's'}`];
  if (s.successRate !== null) parts.push(`${Math.round(s.successRate * 100)}% success`);
  if (s.avgCostUsd !== null) parts.push(`${usd(s.avgCostUsd)} avg`);
  if (s.avgDurationMs !== null) parts.push(`${duration(s.avgDurationMs)} avg`);
  return parts.join(' · ');
}

interface Props {
  currentId: number | null;
  onRestore: (v: PromptVersion) => void;
  onDeleted: (id: number) => void;
}

export function Library({ currentId, onRestore, onDeleted }: Props) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [tag, setTag] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const all = useQuery({ queryKey: ['prompts', '', ''], queryFn: () => api.get<PromptView[]>('/api/prompts') });
  const filtered = !!(dq || tag);
  const shown = useQuery({
    queryKey: ['prompts', dq, tag],
    queryFn: () => api.get<PromptView[]>(`/api/prompts?q=${encodeURIComponent(dq)}&tag=${encodeURIComponent(tag)}`),
    enabled: filtered,
  });
  const list = (filtered ? shown.data : all.data) ?? [];
  const tags = [...new Set((all.data ?? []).flatMap((p) => p.tags))].sort();

  const dup = useMutation({
    mutationFn: (id: number) => api.post<PromptView>(`/api/prompts/${id}/duplicate`),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['prompts'] });
      navigate(`/composer/${p.id}`);
    },
    onError: (e) => setErr(errorText(e)),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.del(`/api/prompts/${id}`),
    onSuccess: (_r, id) => {
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ['prompts'] });
      onDeleted(id);
    },
    onError: (e) => setErr(errorText(e)),
  });

  return (
    <div className="space-y-3" data-testid="library">
      <div>
        <label htmlFor="lib-search" className="sr-only">
          Search prompts
        </label>
        <input id="lib-search" type="search" className={inputCls} placeholder="Search saved prompts" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by tag">
          {tags.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tag === t}
              onClick={() => setTag(tag === t ? '' : t)}
              className={`min-h-[44px] rounded-full border px-4 text-[15px] ${tag === t ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-panel-2 hover:border-accent'}`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      {err && (
        <p role="alert" className="text-[15px] text-error">
          {err}
        </p>
      )}
      {all.isLoading ? (
        <p className="text-muted">Loading…</p>
      ) : !list.length ? (
        <Empty>{filtered ? 'No saved prompt matches.' : 'Nothing saved yet. Compose a prompt and save it to the library.'}</Empty>
      ) : (
        <ul className="space-y-3">
          {list.map((p) => (
            <li key={p.id}>
              <Card className={`p-3 ${p.id === currentId ? 'border-accent' : ''}`} data-testid="library-item">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="break-words text-base font-semibold">{p.title}</h3>
                    <p className="text-[15px] text-muted">
                      v{p.version} · <RelTime ts={p.updatedAt} /> · {p.templateName ?? 'no template'}
                    </p>
                  </div>
                  <span className="text-[15px] text-muted" data-testid="prompt-stats">
                    {statsLine(p.stats)}
                  </span>
                </div>
                {p.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.tags.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="primary" onClick={() => navigate(`/composer/${p.id}`)}>
                    Open
                  </Button>
                  <Button disabled={dup.isPending} onClick={() => dup.mutate(p.id)}>
                    Duplicate
                  </Button>
                  <Button aria-expanded={openId === p.id} onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                    History
                  </Button>
                  {confirm === p.id ? (
                    <>
                      <Button variant="danger" onClick={() => del.mutate(p.id)}>
                        Confirm delete
                      </Button>
                      <Button onClick={() => setConfirm(null)}>Cancel</Button>
                    </>
                  ) : (
                    <Button onClick={() => setConfirm(p.id)}>Delete</Button>
                  )}
                </div>
                {openId === p.id && (
                  <div className="mt-3 border-t border-line pt-3">
                    <Versions promptId={p.id} onRestore={p.id === currentId ? onRestore : undefined} />
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

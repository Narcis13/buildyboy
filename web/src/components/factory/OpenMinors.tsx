// Backlog view of the open minor findings across packages: pick some and make one new package from them.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FindingView, TaskSummary } from '../../../../shared/factory.ts';
import { api } from '../../lib/api.ts';
import { Link, navigate } from '../../lib/router.tsx';
import { inputClass } from '../settings/bits.tsx';
import { Button, Card, Empty } from '../ui.tsx';
import { FindingLocation } from './FindingsSection.tsx';

export const OPEN_MINORS_KEY = ['findings', 'open-minor'] as const;
export const fetchOpenMinors = () => api.get<FindingView[]>('/api/findings?status=open&severity=minor');

export function OpenMinors({ tasks }: { tasks: TaskSummary[] }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: OPEN_MINORS_KEY, queryFn: fetchOpenMinors });
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [title, setTitle] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/tasks', { title: title.trim(), fromFindings: [...picked] }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ['findings'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      navigate(`/backlog/${encodeURIComponent(t.id)}`);
    },
  });
  const toggle = (id: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (q.error) return <div role="alert" className="text-error">Could not load the findings: {(q.error as Error).message}</div>;
  if (!q.data) return <div className="text-muted">Loading…</div>;
  if (!q.data.length) return <div data-testid="open-minors"><Empty>No open minor findings.</Empty></div>;

  const groups = new Map<string, FindingView[]>();
  for (const f of q.data) groups.set(f.taskId, [...(groups.get(f.taskId) ?? []), f]);
  const titleOf = (id: string) => tasks.find((t) => t.id === id)?.title ?? '';

  return (
    <div className="space-y-4" data-testid="open-minors">
      {[...groups].map(([taskId, list]) => (
        <section key={taskId} aria-label={`Open minors of ${taskId}`} data-testid="minors-group" data-task={taskId}>
          <h2 className="mb-1 flex min-h-[44px] flex-wrap items-center gap-2 text-base font-semibold">
            <Link to={`/backlog/${encodeURIComponent(taskId)}`} className="inline-flex min-h-[44px] items-center font-mono text-accent underline">{taskId}</Link>
            <span className="min-w-0 font-normal text-muted [overflow-wrap:anywhere]">{titleOf(taskId)}</span>
            <span className="font-mono text-sm font-normal text-muted">{list.length}</span>
          </h2>
          <ul className="space-y-2">
            {list.map((f) => (
              <li key={f.id}>
                <Card className="p-0">
                  <label className="flex min-h-[44px] cursor-pointer items-start gap-3 p-3">
                    <input type="checkbox" checked={picked.has(f.id)} onChange={() => toggle(f.id)} className="mt-1 h-5 w-5 shrink-0 accent-[var(--bb-accent)]" data-testid="minor-check" data-finding={f.id} />
                    <span className="min-w-0">
                      <span className="block text-[15px] font-medium leading-snug [overflow-wrap:anywhere]">{f.title}</span>
                      <FindingLocation f={f} />
                      <span className="block text-sm text-muted">{f.gate} · round {f.round}</span>
                    </span>
                  </label>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {picked.size > 0 && (
        <form
          className="sticky bottom-2 flex flex-wrap items-end gap-3 rounded-xl border border-accent bg-panel p-3"
          data-testid="minors-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) create.mutate();
          }}
        >
          <div className="min-w-0 flex-1 basis-56">
            <label htmlFor="minors-title" className="mb-1 block text-[15px] font-medium">Package title ({picked.size} finding{picked.size > 1 ? 's' : ''})</label>
            <input id="minors-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={inputClass} data-testid="minors-title" />
          </div>
          <Button type="submit" variant="primary" disabled={!title.trim() || create.isPending} data-testid="minors-create">{create.isPending ? 'Creating…' : 'Create package'}</Button>
          {create.error && <div role="alert" className="basis-full text-error">{(create.error as Error).message}</div>}
        </form>
      )}
    </div>
  );
}

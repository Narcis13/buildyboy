import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STATUS_LABEL, type TaskStatus, type TaskSummary } from '../../../../shared/factory.ts';
import { api } from '../../lib/api.ts';
import { Button, Card, Toggle } from '../ui.tsx';
import { Field, inputClass } from '../settings/bits.tsx';

const START_STATUSES: TaskStatus[] = ['backlog', 'gata'];

/** Creates one package. Works on the phone: one column, 44px controls, dependencies picked from a filtered checklist. */
export function NewTaskForm({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [id, setId] = useState('');
  const [body, setBody] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [deps, setDeps] = useState<string[]>([]);
  const [depFilter, setDepFilter] = useState('');
  const [status, setStatus] = useState<TaskStatus>('backlog');
  const [priority, setPriority] = useState('0');
  const [sensitive, setSensitive] = useState(false);
  const all = useQuery({ queryKey: ['tasks', 'all'], queryFn: () => api.get<TaskSummary[]>('/api/tasks') });

  const create = useMutation({
    mutationFn: () =>
      api.post<TaskSummary>('/api/tasks', {
        ...(id.trim() ? { id: id.trim() } : {}),
        title: title.trim(),
        body: body.trim() || undefined,
        acceptance: acceptance.split('\n').map((l) => l.trim()).filter(Boolean),
        dependsOn: deps,
        status,
        priority: Number.isFinite(Number(priority)) ? Math.round(Number(priority)) : 0,
        sensitive,
      }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      onDone(t.id);
    },
  });

  const q = depFilter.trim().toLowerCase();
  const candidates = (all.data ?? []).filter((t) => !q || t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q));
  const toggleDep = (tid: string) => setDeps((d) => (d.includes(tid) ? d.filter((x) => x !== tid) : [...d, tid]));

  return (
    <Card className="mb-4 p-4" data-testid="new-task">
      <h2 className="text-base font-semibold tracking-wide">New task</h2>
      <form
        className="mt-3 grid gap-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) create.mutate();
        }}
      >
        <div className="min-w-0 space-y-4">
          <Field label="Title" htmlFor="nt-title">
            <input id="nt-title" required value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} data-testid="nt-title" maxLength={200} />
          </Field>
          <Field label="Id (optional)" htmlFor="nt-id" hint="Letters, digits, dot, dash. Empty picks the next T number.">
            <input id="nt-id" value={id} onChange={(e) => setId(e.target.value)} className={`${inputClass} font-mono`} data-testid="nt-id" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </Field>
          <Field label="Description" htmlFor="nt-body">
            <textarea id="nt-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} className={`${inputClass} py-2`} data-testid="nt-body" />
          </Field>
          <Field label="Acceptance criteria" htmlFor="nt-acc" hint="One per line.">
            <textarea id="nt-acc" rows={4} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} className={`${inputClass} py-2`} data-testid="nt-acceptance" />
          </Field>
        </div>
        <div className="min-w-0 space-y-4">
          <fieldset>
            <legend className="mb-1 text-[15px] font-medium">Depends on</legend>
            {deps.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5" data-testid="nt-deps-chosen">
                {deps.map((d) => (
                  <button key={d} type="button" onClick={() => toggleDep(d)} className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-accent px-3 font-mono text-sm" aria-label={`Remove dependency ${d}`}>
                    {d} <span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
            )}
            {all.data && all.data.length > 0 ? (
              <>
                <input aria-label="Filter tasks" placeholder="Filter tasks" value={depFilter} onChange={(e) => setDepFilter(e.target.value)} className={`${inputClass} mb-1`} />
                <ul className="max-h-48 overflow-y-auto rounded-lg border border-line" data-testid="nt-deps">
                  {candidates.map((t) => (
                    <li key={t.id}>
                      <label className="flex min-h-[44px] cursor-pointer items-center gap-3 px-3 hover:bg-panel-2">
                        <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--bb-accent)]" checked={deps.includes(t.id)} onChange={() => toggleDep(t.id)} />
                        <span className="font-mono text-sm text-accent">{t.id}</span>
                        <span className="min-w-0 truncate text-[15px]">{t.title}</span>
                      </label>
                    </li>
                  ))}
                  {!candidates.length && <li className="px-3 py-2 text-sm text-muted">No task matches.</li>}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted">No tasks yet.</p>
            )}
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Status" htmlFor="nt-status">
              <select id="nt-status" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)} className={inputClass} data-testid="nt-status">
                {START_STATUSES.map((s) => (
                  <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                ))}
              </select>
            </Field>
            <Field label="Priority" htmlFor="nt-priority">
              <input id="nt-priority" type="number" inputMode="numeric" step={1} min={-1000} max={1000} value={priority} onChange={(e) => setPriority(e.target.value)} className={inputClass} />
            </Field>
          </div>
          <div>
            <Toggle on={sensitive} onChange={setSensitive} label="Sensitive" />
            <p className="-mt-1 pl-[3.25rem] text-sm text-muted">Auth, RLS, import, pseudonymisation: flagged in the digest.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 md:col-span-2">
          <Button type="submit" variant="primary" disabled={!title.trim() || create.isPending} data-testid="nt-submit">
            {create.isPending ? 'Creating…' : 'Create task'}
          </Button>
          <Button type="button" onClick={() => onDone('')}>Cancel</Button>
          {create.error && <span className="text-error" role="alert" data-testid="nt-error">{(create.error as Error).message}</span>}
        </div>
      </form>
    </Card>
  );
}

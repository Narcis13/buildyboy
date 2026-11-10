import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { STATUS_LABEL, TASK_STATUSES, type TaskStatus, type TaskSummary } from '../../../shared/factory.ts';
import { api } from '../lib/api.ts';
import { navigate } from '../lib/router.tsx';
import { Button, Empty, PageTitle } from '../components/ui.tsx';
import { inputClass } from '../components/settings/bits.tsx';
import { GovernorBanner } from '../components/factory/GovernorBanner.tsx';
import { ImportPanel } from '../components/factory/ImportPanel.tsx';
import { fetchOpenMinors, OPEN_MINORS_KEY, OpenMinors } from '../components/factory/OpenMinors.tsx';
import { NewTaskForm } from '../components/factory/NewTaskForm.tsx';
import { STATUS_COLOR, TaskCard, useMedia } from '../components/factory/common.tsx';

type Filter = 'all' | TaskStatus;

/** Phone: one list under a status filter with counts. */
function PhoneList({ tasks }: { tasks: TaskSummary[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const count = (s: Filter) => (s === 'all' ? tasks.length : tasks.filter((t) => t.status === s).length);
  const shown = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);
  const tabs: { id: Filter; label: string }[] = [{ id: 'all', label: 'All' }, ...TASK_STATUSES.map((s) => ({ id: s as Filter, label: STATUS_LABEL[s] }))];
  return (
    <section aria-label="Tasks">
      <div role="tablist" aria-label="Status" className="-mx-4 mb-3 flex gap-1 overflow-x-auto border-b border-line px-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={filter === t.id}
            data-testid={`filter-${t.id}`}
            onClick={() => setFilter(t.id)}
            className={`min-h-[44px] shrink-0 whitespace-nowrap border-b-2 px-3 text-[15px] ${filter === t.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {t.label} <span className="font-mono text-sm text-muted">{count(t.id)}</span>
          </button>
        ))}
      </div>
      {!shown.length && <Empty>No tasks here.</Empty>}
      <ul className="flex flex-col gap-2">
        {shown.map((t) => (
          <li key={t.id}>
            <TaskCard t={t} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Desktop: one column per status, in order. */
function Board({ tasks }: { tasks: TaskSummary[] }) {
  return (
    <div className="grid items-start gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="board">
      {TASK_STATUSES.map((s) => {
        const col = tasks.filter((t) => t.status === s);
        return (
          <section key={s} aria-label={STATUS_LABEL[s]} data-testid={`column-${s}`} className="min-w-0 rounded-xl bg-bg-2/60 p-2">
            <h2 className="mb-2 flex min-h-[32px] items-center gap-2 px-1 text-sm font-semibold uppercase tracking-wider" style={{ color: STATUS_COLOR[s] }}>
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[s] }} aria-hidden="true" />
              {STATUS_LABEL[s]}
              <span className="font-mono font-normal text-muted">{col.length}</span>
            </h2>
            <ul className="flex flex-col gap-2">
              {col.map((t) => (
                <li key={t.id}>
                  <TaskCard t={t} />
                </li>
              ))}
            </ul>
            {!col.length && <div className="px-1 py-3 text-sm text-muted">Empty</div>}
          </section>
        );
      })}
    </div>
  );
}

export default function Backlog() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [panel, setPanel] = useState<'new' | 'import' | null>(null);
  const [minors, setMinors] = useState(false);
  const minorCount = useQuery({ queryKey: OPEN_MINORS_KEY, queryFn: fetchOpenMinors }).data?.length;
  const wide = useMedia('(min-width: 768px)');
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['tasks', 'list', q],
    queryFn: () => api.get<TaskSummary[]>(`/api/tasks${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    placeholderData: keepPreviousData,
  });

  return (
    <div data-testid="backlog-page" className="mx-auto max-w-[1600px]">
      <PageTitle
        right={
          <div className="flex gap-2">
            <Button variant={panel === 'import' ? 'primary' : 'ghost'} onClick={() => setPanel(panel === 'import' ? null : 'import')} data-testid="import-open">Import</Button>
            <Button variant="primary" onClick={() => setPanel(panel === 'new' ? null : 'new')} data-testid="new-task-open">New task</Button>
          </div>
        }
      >
        Backlog
      </PageTitle>
      <GovernorBanner />
      {panel === 'new' && (
        <NewTaskForm
          onDone={(id) => {
            setPanel(null);
            if (id) navigate(`/backlog/${encodeURIComponent(id)}`);
          }}
        />
      )}
      {panel === 'import' && <ImportPanel onClose={() => setPanel(null)} />}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search tasks"
          placeholder="Search id, title or description"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${inputClass} min-w-0 flex-1 basis-56 md:max-w-md`}
          data-testid="backlog-search"
        />
        <Button variant={minors ? 'primary' : 'ghost'} aria-pressed={minors} onClick={() => setMinors(!minors)} data-testid="backlog-open-minors">
          Open minors{minorCount != null ? ` ${minorCount}` : ''}
        </Button>
      </div>
      {error && <div role="alert" className="mb-3 text-error">Could not load the backlog: {(error as Error).message}</div>}
      {isLoading && <div className="text-muted">Loading…</div>}
      {minors && <OpenMinors tasks={data ?? []} />}
      {!minors && data && !data.length && !q && <Empty>No tasks yet. Create one, or import Markdown files or GitHub issues.</Empty>}
      {!minors && data && !data.length && q && <Empty>No task matches “{q}”.</Empty>}
      {!minors && data && data.length > 0 && (wide ? <Board tasks={data} /> : <PhoneList tasks={data} />)}
    </div>
  );
}

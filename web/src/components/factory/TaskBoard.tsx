// The backlog board: one column per status on a desktop, one filtered list on a phone. Used by the Backlog page and a
// project's Backlog tab. `archive` goes under the Integrată column (on a phone: under the list), e.g. "4 archived".
import { useState, type ReactNode } from 'react';
import { STATUS_LABEL, TASK_STATUSES, type TaskStatus, type TaskSummary } from '../../../../shared/factory.ts';
import { Empty } from '../ui.tsx';
import { STATUS_COLOR, TaskCard, useMedia } from './common.tsx';

type Filter = 'all' | TaskStatus;

interface BoardProps {
  tasks: TaskSummary[];
  showProject?: boolean;
  archive?: ReactNode;
}

/** Phone: one list under a status filter with counts. */
function PhoneList({ tasks, showProject, archive }: BoardProps) {
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
            <TaskCard t={t} showProject={showProject} />
          </li>
        ))}
      </ul>
      {archive && (filter === 'all' || filter === 'integrata') && <div className="mt-3">{archive}</div>}
    </section>
  );
}

/** Desktop: one column per status, in order. */
function Columns({ tasks, showProject, archive }: BoardProps) {
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
                  <TaskCard t={t} showProject={showProject} />
                </li>
              ))}
            </ul>
            {!col.length && <div className="px-1 py-3 text-sm text-muted">Empty</div>}
            {s === 'integrata' && archive && <div className="mt-1 px-1">{archive}</div>}
          </section>
        );
      })}
    </div>
  );
}

export function TaskBoard(props: BoardProps) {
  const wide = useMedia('(min-width: 768px)');
  return wide ? <Columns {...props} /> : <PhoneList {...props} />;
}

// Shared pieces of the factory pages: status and verdict colours, chips, the task card and small hooks.
import { useEffect, useState, type ReactNode } from 'react';
import { GATES, GATE_LABEL, STATUS_LABEL, type Gate, type TaskStatus, type TaskSummary, type Verdict } from '../../../../shared/factory.ts';
import { usd } from '../../lib/format.ts';
import { Link } from '../../lib/router.tsx';
import { Badge, Card } from '../ui.tsx';

export const STATUS_COLOR: Record<TaskStatus, string> = {
  backlog: 'var(--bb-ended)',
  gata: 'var(--bb-accent)',
  in_lucru: 'var(--bb-working)',
  la_porti: 'var(--bb-tool-edit)',
  integrata: 'var(--bb-idle)',
  blocata: 'var(--bb-error)',
};

export const VERDICT_COLOR: Record<Verdict, string> = {
  pass: 'var(--bb-working)',
  fail: 'var(--bb-error)',
  skip: 'var(--bb-ended)',
};
const VERDICT_MARK: Record<Verdict, string> = { pass: '✓', fail: '✕', skip: '–' };

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge color={STATUS_COLOR[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <Badge color={VERDICT_COLOR[verdict]}>
      {VERDICT_MARK[verdict]} {verdict}
    </Badge>
  );
}

/** G1–G5, each coloured by its latest verdict; grey and dashed when the gate has no result yet. */
export function GateChips({ gates }: { gates: Partial<Record<Gate, Verdict>> }) {
  return (
    <span className="inline-flex flex-wrap gap-1" data-testid="gate-chips">
      {GATES.map((g) => {
        const v = gates[g];
        const color = v ? VERDICT_COLOR[v] : 'var(--bb-muted)';
        return (
          <span
            key={g}
            title={`${g}: ${v ?? 'no result yet'} (${GATE_LABEL[g]})`}
            aria-label={`${g} ${v ?? 'no result'}`}
            data-gate={g}
            data-verdict={v ?? 'none'}
            className={`inline-flex items-center rounded border px-1 py-px font-mono text-xs ${v ? '' : 'border-dashed opacity-70'}`}
            style={{ color, borderColor: `color-mix(in srgb, ${color} 55%, transparent)`, background: v ? `color-mix(in srgb, ${color} 14%, transparent)` : undefined }}
          >
            {g}
            {v ? <span aria-hidden="true">{VERDICT_MARK[v]}</span> : null}
          </span>
        );
      })}
    </span>
  );
}

export function TaskFlags({ t }: { t: Pick<TaskSummary, 'ready' | 'sensitive' | 'openControls'> }) {
  return (
    <>
      {t.ready && <Badge color="var(--bb-working)">ready</Badge>}
      {t.sensitive && (
        <Badge color="var(--bb-waiting)" className="normal-case">
          <span title="Sensitive: flagged in the digest">⚑ sensitive</span>
        </Badge>
      )}
      {t.openControls > 0 && (
        <Badge color="var(--bb-error)" className="normal-case">
          <span title="Open stop or revert requests the coordinator has not acknowledged yet">
            {t.openControls} open request{t.openControls > 1 ? 's' : ''}
          </span>
        </Badge>
      )}
    </>
  );
}

/** One package on the board. The whole card is a link to its page. */
export function TaskCard({ t }: { t: TaskSummary }) {
  return (
    <Link to={`/backlog/${encodeURIComponent(t.id)}`} data-testid="task-card" data-task={t.id} className="block min-w-0">
      <Card className="flex min-h-[44px] flex-col gap-1.5 p-3 hover:border-accent">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-sm font-semibold text-accent">{t.id}</span>
          <TaskFlags t={t} />
        </div>
        <div className="text-[15px] font-medium leading-snug [overflow-wrap:anywhere]">{t.title}</div>
        {t.waitingOn.length > 0 && <div className="text-sm text-muted [overflow-wrap:anywhere]">waits on {t.waitingOn.join(', ')}</div>}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <GateChips gates={t.gates} />
          {t.costUsd != null && <span className="text-sm tabular-nums text-muted">{usd(t.costUsd)}</span>}
        </div>
      </Card>
    </Link>
  );
}

/** A CSS media query as a boolean, so only one of the phone / desktop layouts is mounted. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const h = () => setOn(m.matches);
    m.addEventListener('change', h);
    h();
    return () => m.removeEventListener('change', h);
  }, [query]);
  return on;
}

/** Collapsible region used on the package page. */
export function Section({ title, count, children, right, testId }: { title: string; count?: number; children: ReactNode; right?: ReactNode; testId?: string }) {
  return (
    <section className="min-w-0" data-testid={testId}>
      <div className="mb-2 flex min-h-[44px] flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold tracking-wide">
          {title}
          {count != null && <span className="ml-2 font-mono text-sm font-normal text-muted">{count}</span>}
        </h2>
        {right}
      </div>
      {children}
    </section>
  );
}

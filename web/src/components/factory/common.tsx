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

/** One package on the board. The whole card is a link to its page. `showProject`: when the board mixes projects. */
export function TaskCard({ t, showProject }: { t: TaskSummary; showProject?: boolean }) {
  return (
    <Link to={`/backlog/${encodeURIComponent(t.id)}`} data-testid="task-card" data-task={t.id} className="block min-w-0">
      <Card className="flex min-h-[44px] flex-col gap-1.5 p-3 hover:border-accent">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-sm font-semibold text-accent">{t.id}</span>
          {showProject && t.project && (
            <span className="rounded bg-panel-2 px-1.5 font-mono text-xs leading-5 text-muted" data-testid="task-card-project">
              {t.project}
            </span>
          )}
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

// ---------- the line (SPEC §12.5) ----------

/** The stages of the line, in order, as the conductor writes them in `stage` (gates upper-case, the rest lower-case). */
export const STAGES = ['prepare', 'qa', 'build', 'G1', 'G2', 'G3', 'G4', 'G5', 'cleanup'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<Stage, string> = {
  prepare: 'Prepare', qa: 'QA', build: 'Build', G1: 'G1', G2: 'G2', G3: 'G3', G4: 'G4', G5: 'G5', cleanup: 'Cleanup',
};
const STAGE_SHORT: Record<Stage, string> = { ...STAGE_LABEL, prepare: 'Prep', cleanup: 'Clean' };

/**
 * Where a package is on the line: the conductor's `stage` when it set one; until then a position derived from the
 * status and the gate verdicts (in_lucru → Build; la_porti → the first gate without a pass or skip). Null off the line.
 */
export function stageOf(t: Pick<TaskSummary, 'stage' | 'status' | 'gates'>): { stage: Stage; derived: boolean } | null {
  if (t.stage) {
    const s = STAGES.find((x) => x.toLowerCase() === t.stage!.toLowerCase());
    if (s) return { stage: s, derived: false };
  }
  if (t.status === 'in_lucru') return { stage: 'build', derived: true };
  if (t.status === 'la_porti') return { stage: GATES.find((g) => t.gates[g] !== 'pass' && t.gates[g] !== 'skip') ?? 'G5', derived: true };
  return null;
}

/** Prepare · QA · Build · G1…G5 · Cleanup: done steps filled, the current one marked; a gate step takes its verdict's colour. */
export function StageStepper({ t }: { t: Pick<TaskSummary, 'stage' | 'status' | 'gates'> }) {
  const at = stageOf(t);
  const cur = at ? STAGES.indexOf(at.stage) : -1;
  return (
    <ol
      className="grid grid-cols-9 gap-0.5"
      aria-label={at ? `Stage: ${STAGE_LABEL[at.stage]}${at.derived ? ' (estimated)' : ''}` : 'Not on the line'}
      data-testid="stage-stepper"
      data-stage={at?.stage ?? ''}
    >
      {STAGES.map((s, i) => {
        const verdict = (GATES as readonly string[]).includes(s) ? t.gates[s as Gate] : undefined;
        const state = i < cur ? 'done' : i === cur ? 'current' : 'todo';
        const color =
          state === 'current'
            ? verdict === 'fail' ? 'var(--bb-error)' : 'var(--bb-accent)'
            : verdict ? VERDICT_COLOR[verdict] : state === 'done' ? 'var(--bb-working)' : 'var(--bb-line)';
        return (
          <li key={s} data-step={s} data-state={state} aria-current={state === 'current' ? 'step' : undefined} className="min-w-0" title={`${STAGE_LABEL[s]}${verdict ? `: ${verdict}` : ''}`}>
            <span className={`block rounded-full ${state === 'current' ? 'h-2' : 'h-1.5'}`} style={{ background: color }} />
            <span className={`mt-1 block truncate text-center text-[11px] leading-4 sm:text-xs ${state === 'current' ? 'font-semibold text-ink' : 'text-muted'}`}>
              <span className="sm:hidden">{STAGE_SHORT[s]}</span>
              <span className="hidden sm:inline">{STAGE_LABEL[s]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

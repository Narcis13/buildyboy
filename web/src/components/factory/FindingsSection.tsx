// Findings of a package (what the gates found, by severity, each with a status to change) and the gate runs the runner made.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FINDING_STATUSES, type FindingSeverity, type FindingStatus, type FindingView, type GateRunView } from '../../../../shared/factory.ts';
import { api } from '../../lib/api.ts';
import { Link } from '../../lib/router.tsx';
import { inputClass } from '../settings/bits.tsx';
import { Badge, Card, RelTime } from '../ui.tsx';
import { VerdictBadge } from './common.tsx';

export const SEVERITY_COLOR: Record<FindingSeverity, string> = {
  blocker: 'var(--bb-error)',
  major: 'var(--bb-waiting)',
  minor: 'var(--bb-muted)',
};

export const FINDING_STATUS_LABEL: Record<FindingStatus, string> = {
  open: 'Open',
  fixed: 'Fixed',
  deferred: 'Deferred',
  for_architect: 'For architect',
  wontfix: "Won't fix",
};

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  return <Badge color={SEVERITY_COLOR[severity]}>{severity}</Badge>;
}

export function FindingLocation({ f }: { f: Pick<FindingView, 'file' | 'line'> }) {
  if (!f.file) return null;
  return <span className="font-mono text-sm text-muted [overflow-wrap:anywhere]">{f.file}{f.line ? `:${f.line}` : ''}</span>;
}

function FindingRow({ f, taskId }: { f: FindingView; taskId: string }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (status: FindingStatus) => api.post('/api/findings/update', { ids: [f.id], status }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['findings'] });
    },
  });
  return (
    <li>
      <Card className="p-3" data-testid="finding-row" data-finding={f.id} data-severity={f.severity} data-status={f.status}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <SeverityBadge severity={f.severity} />
          <span className="font-mono text-sm text-accent">{f.gate}</span>
          <span className="text-sm text-muted">round {f.round}</span>
          {f.deferredTo && (
            <Link to={`/backlog/${encodeURIComponent(f.deferredTo)}`} className="inline-flex min-h-[44px] items-center font-mono text-sm text-accent underline" data-testid="finding-deferred-to">
              → {f.deferredTo}
            </Link>
          )}
        </div>
        <div className="mt-1 text-[15px] font-medium leading-snug [overflow-wrap:anywhere]" data-testid="finding-title">{f.title}</div>
        <FindingLocation f={f} />
        {(f.detail || f.fix) && (
          <details className="mt-1" data-testid="finding-more">
            <summary className="flex min-h-[44px] cursor-pointer items-center text-sm text-muted">Detail and fix</summary>
            {f.detail && <p className="whitespace-pre-wrap text-[15px] [overflow-wrap:anywhere]">{f.detail}</p>}
            {f.fix && (
              <p className="mt-2 whitespace-pre-wrap text-[15px] [overflow-wrap:anywhere]">
                <span className="text-muted">Fix: </span>
                {f.fix}
              </p>
            )}
          </details>
        )}
        {f.note && <p className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">{f.note}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor={`finding-status-${f.id}`} className="sr-only">Status of finding {f.id}</label>
          <select id={`finding-status-${f.id}`} value={f.status} disabled={set.isPending} onChange={(e) => set.mutate(e.target.value as FindingStatus)} className={`${inputClass} w-auto min-w-[10rem]`} data-testid="finding-status">
            {FINDING_STATUSES.map((s) => (
              <option key={s} value={s}>{FINDING_STATUS_LABEL[s]}</option>
            ))}
          </select>
          {set.error && <span role="alert" className="text-error">{(set.error as Error).message}</span>}
        </div>
      </Card>
    </li>
  );
}

/** Findings newest first as the server returns them; open ones lead. */
export function FindingsSection({ findings, taskId }: { findings: FindingView[]; taskId: string }) {
  if (!findings.length) return <div className="text-muted" data-testid="findings-empty">No findings.</div>;
  const sorted = [...findings].sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open'));
  return (
    <ul className="space-y-2" data-testid="findings">
      {sorted.map((f) => (
        <FindingRow key={f.id} f={f} taskId={taskId} />
      ))}
    </ul>
  );
}

const RUN_COLOR: Record<GateRunView['status'], string> = {
  queued: 'var(--bb-muted)',
  running: 'var(--bb-working)',
  done: 'var(--bb-idle)',
  error: 'var(--bb-error)',
};

/** Gates the runner ran from the repo's recipe; the log opens in a new tab. */
export function GateRunsList({ runs }: { runs: GateRunView[] }) {
  return (
    <ul className="space-y-2" data-testid="gate-runs">
      {runs.map((r) => (
        <li key={r.id}>
          <Card className="p-3" data-testid="gate-run-row" data-run={r.id} data-status={r.status}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono font-semibold text-accent">{r.gate}</span>
              <span className="text-sm text-muted">round {r.round}</span>
              <Badge color={RUN_COLOR[r.status]}>{r.status}</Badge>
              {r.verdict && <VerdictBadge verdict={r.verdict} />}
              <RelTime ts={r.finishedAt ?? r.startedAt ?? r.createdAt} className="text-sm text-muted" />
              <a href={`/api/gate-runs/${encodeURIComponent(r.id)}/log`} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex min-h-[44px] items-center px-2 text-accent underline" data-testid="gate-run-log">
                Log
              </a>
            </div>
            {r.summary && <p className="mt-1 whitespace-pre-wrap text-[15px] [overflow-wrap:anywhere]">{r.summary}</p>}
            {r.error && <p className="mt-1 text-[15px] text-error [overflow-wrap:anywhere]">{r.error}</p>}
          </Card>
        </li>
      ))}
    </ul>
  );
}

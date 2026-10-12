import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ActionAnswer, PendingActionView, PendingKind } from '../../../../shared/types.ts';
import { api, ApiError } from '../../lib/api.ts';
import { exactTime } from '../../lib/format.ts';
import { Link } from '../../lib/router.tsx';
import { Badge, Card, Markdown, RelTime } from '../ui.tsx';
import { PermissionControls, PlanControls, QuestionControls, StopWaitControls } from './Controls.tsx';
import { ToolPreview } from './ToolPreview.tsx';

export const KIND_LABEL: Record<PendingKind, string> = {
  permission: 'Permission',
  question: 'Question',
  plan: 'Plan',
  stop_wait: 'Turn finished',
  pause: 'Paused',
};

const KIND_COLOR: Record<PendingKind, string> = {
  permission: 'var(--bb-waiting)',
  question: 'var(--bb-accent)',
  plan: 'var(--bb-tool-edit)',
  stop_wait: 'var(--bb-idle)',
  pause: 'var(--bb-muted)',
};

function Context({ r }: { r: PendingActionView['request'] }) {
  const bits = [r.machineName, r.projectName].filter(Boolean);
  return (
    <div className="min-w-0 text-sm text-muted">
      <div className="truncate">{bits.join(' · ')}</div>
      <div className="flex min-w-0 flex-wrap gap-x-3 font-mono">
        {r.cwd && <span className="truncate" title={r.cwd}>{r.cwd}</span>}
        {r.branch && <span className="shrink-0">⎇ {r.branch}</span>}
      </div>
    </div>
  );
}

/** Claude's last message, clamped; tap to expand. */
function LastMessage({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420;
  return (
    <div className="rounded-lg bg-panel-2 p-3" data-testid="inbox-last-message">
      <div className="mb-1 text-xs uppercase tracking-wider text-muted">Claude said</div>
      <div className={!open && long ? 'max-h-32 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]' : ''}>
        <Markdown text={text} />
      </div>
      {long && (
        <button className="mt-1 min-h-[44px] text-sm text-accent" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** One pending action with everything needed to decide, plus the controls for its kind. */
export function ActionCard({ action, highlighted }: { action: PendingActionView; highlighted?: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const r = action.request;
  const m = useMutation({
    mutationFn: (answer: ActionAnswer) => api.post(`/api/actions/${action.id}/answer`, answer),
    onMutate: () => setError(null),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['inbox'] });
      qc.invalidateQueries({ queryKey: ['attention'] });
    },
    onError: (e) => setError(e instanceof ApiError && e.status === 409 ? 'Already answered (probably at your desk).' : `Could not send: ${(e as Error).message}`),
  });
  const props = { action, busy: m.isPending, send: (a: ActionAnswer) => m.mutate(a) };

  return (
    <Card id={action.id} data-testid="inbox-card" data-kind={action.kind} className={`scroll-mt-16 p-4 ${highlighted ? 'border-accent ring-1 ring-accent' : ''}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge color={KIND_COLOR[action.kind]}>{KIND_LABEL[action.kind]}</Badge>
          {action.toolName && <Badge color="var(--bb-tool-bash)">{action.toolName}</Badge>}
        </div>
        <RelTime ts={action.createdAt} className="shrink-0 text-sm text-muted" />
      </div>
      <Link to={`/s/${action.sessionId}`} data-testid="inbox-session-link" className="mb-1 flex min-h-[44px] items-center gap-2 text-base font-semibold hover:text-accent">
        <span className="min-w-0 truncate">{r.sessionName ?? action.sessionId.slice(0, 8)}</span>
        <span aria-hidden className="text-muted">›</span>
      </Link>
      <Context r={r} />

      <div className="mt-3 space-y-3">
        {r.lastAssistantMessage && <LastMessage text={r.lastAssistantMessage} />}
        {action.kind === 'permission' && <ToolPreview tool={action.toolName} input={r.toolInput} />}
        {action.kind === 'permission' && <PermissionControls {...props} />}
        {action.kind === 'question' && <QuestionControls {...props} />}
        {action.kind === 'plan' && <PlanControls {...props} />}
        {action.kind === 'stop_wait' && <StopWaitControls {...props} />}
        {error && <div role="alert" className="text-error">{error}</div>}
      </div>
    </Card>
  );
}

function summarize(a: PendingActionView): string {
  if (a.status === 'timeout') return 'Timed out — the local prompt applied';
  if (a.status === 'superseded') return 'Answered at the terminal';
  const x = a.response as Record<string, unknown> | null;
  if (!x) return 'Answered';
  switch (x.type) {
    case 'allow': return x.scope === 'session' ? 'Allowed for this session' : 'Allowed once';
    case 'deny': return `Denied${x.interrupt ? ' and interrupted' : ''}${x.message ? `: ${String(x.message)}` : ''}`;
    case 'answers': return `Answered: ${Object.values((x.answers as Record<string, string>) ?? {}).join(' / ')}`;
    case 'reply': return `Replied: ${String(x.text ?? '')}`;
    case 'release': return 'Let go idle';
    default: return 'Answered';
  }
}

/** Compact row for answered / expired items. */
export function HistoryRow({ action }: { action: PendingActionView }) {
  const color = action.status === 'answered' ? 'var(--bb-working)' : action.status === 'timeout' ? 'var(--bb-waiting)' : 'var(--bb-muted)';
  return (
    <li data-testid="history-row">
      <Link to={`/s/${action.sessionId}`} className="block min-h-[44px] rounded-lg border border-line bg-panel p-3 transition hover:border-accent">
        <div className="flex flex-wrap items-center gap-2">
          <Badge color={color}>{action.status}</Badge>
          <Badge color={KIND_COLOR[action.kind]}>{KIND_LABEL[action.kind]}</Badge>
          {action.toolName && <span className="font-mono text-sm">{action.toolName}</span>}
          <RelTime ts={action.answeredAt ?? action.createdAt} className="ml-auto text-sm text-muted" />
        </div>
        <div className="mt-1 break-words text-[15px]">{summarize(action)}</div>
        <div className="mt-0.5 truncate text-sm text-muted" title={exactTime(action.createdAt)}>
          {[action.request.projectName, action.request.sessionName].filter(Boolean).join(' · ')}
          {action.answeredBy ? ` · by ${action.answeredBy}` : ''}
        </div>
      </Link>
    </li>
  );
}

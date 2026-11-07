import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DecisionView } from '../../../../shared/factory.ts';
import { api } from '../../lib/api.ts';
import { Link } from '../../lib/router.tsx';
import { Badge, Button, Card, RelTime } from '../ui.tsx';
import { inputClass } from '../settings/bits.tsx';

/** A question from the coordinator. Pending: one-tap options, a free-text answer, cancel. Otherwise a read-only record. */
export function DecisionCard({ d, highlighted, showTask = true }: { d: DecisionView; highlighted?: boolean; showTask?: boolean }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const pending = d.status === 'pending';

  const settle = () => {
    qc.invalidateQueries({ queryKey: ['decisions'] });
    qc.invalidateQueries({ queryKey: ['attention'] });
    qc.invalidateQueries({ queryKey: ['tasks'] });
    if (d.taskId) qc.invalidateQueries({ queryKey: ['task', d.taskId] });
  };
  const answer = useMutation({
    mutationFn: (a: string) => api.post(`/api/decisions/${d.id}/answer`, { answer: a }),
    onSettled: settle,
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/api/decisions/${d.id}/cancel`),
    onSettled: settle,
  });
  const busy = answer.isPending || cancel.isPending;
  const error = (answer.error ?? cancel.error) as Error | null;

  return (
    <Card
      id={d.id}
      data-testid="decision-card"
      data-status={d.status}
      className={`space-y-3 p-4 ${pending ? 'border-waiting' : ''} ${highlighted ? 'ring-2 ring-accent' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        {pending ? <Badge color="var(--bb-waiting)">pending</Badge> : <Badge color={d.status === 'answered' ? 'var(--bb-working)' : 'var(--bb-ended)'}>{d.status}</Badge>}
        {showTask && d.taskId && (
          <Link to={`/backlog/${encodeURIComponent(d.taskId)}`} className="inline-flex min-h-[44px] items-center font-mono text-accent underline" data-testid="decision-task">
            {d.taskId}
          </Link>
        )}
        <span className="truncate">{d.askedBy}</span>
        <RelTime ts={d.createdAt} />
      </div>
      <h3 className="whitespace-pre-wrap text-base font-semibold leading-snug [overflow-wrap:anywhere]" data-testid="decision-question">{d.question}</h3>
      {d.context && (
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-panel-2 p-3 text-[15px] [overflow-wrap:anywhere]" data-testid="decision-context">{d.context}</div>
      )}

      {pending ? (
        <>
          {d.options.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Options">
              {d.options.map((o) => (
                <Button key={o} variant="primary" disabled={busy} className="h-auto py-2 text-left [overflow-wrap:anywhere]" onClick={() => answer.mutate(o)} data-testid="decision-option">
                  {o}
                </Button>
              ))}
            </div>
          )}
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) answer.mutate(text.trim());
            }}
          >
            <label htmlFor={`ans-${d.id}`} className="block text-[15px] font-medium">{d.options.length ? 'Or write your own answer' : 'Your answer'}</label>
            <textarea id={`ans-${d.id}`} rows={2} value={text} onChange={(e) => setText(e.target.value)} className={`${inputClass} py-2`} data-testid="decision-text" />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="ok" disabled={busy || !text.trim()} data-testid="decision-send">Send answer</Button>
              {confirmCancel ? (
                <>
                  <Button type="button" variant="danger" disabled={busy} onClick={() => cancel.mutate()} data-testid="decision-cancel-confirm">Yes, cancel it</Button>
                  <Button type="button" onClick={() => setConfirmCancel(false)}>Keep</Button>
                </>
              ) : (
                <Button type="button" disabled={busy} onClick={() => setConfirmCancel(true)} data-testid="decision-cancel">Cancel question</Button>
              )}
            </div>
          </form>
          {error && <div role="alert" className="text-error">{error.message}</div>}
        </>
      ) : (
        <div className="text-[15px]" data-testid="decision-answer">
          {d.status === 'answered' ? (
            <>
              <span className="text-muted">Answer: </span>
              <span className="whitespace-pre-wrap font-medium [overflow-wrap:anywhere]">{d.answer}</span>
            </>
          ) : (
            <span className="text-muted">Cancelled</span>
          )}
          {d.answeredAt && (
            <span className="text-sm text-muted">
              {' '}
              · <RelTime ts={d.answeredAt} />
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

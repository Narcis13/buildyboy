import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ControlRequest } from '../../../../shared/factory.ts';
import { api } from '../../lib/api.ts';
import { Badge, Button, Card, RelTime } from '../ui.tsx';
import { inputClass } from '../settings/bits.tsx';

type Kind = ControlRequest['kind'];

const KINDS: Record<Kind, { button: string; title: string; effect: string }> = {
  stop: {
    button: 'Oprește pachetul',
    title: 'Stop this package',
    effect: 'The coordinator will stop the worker on this package.',
  },
  revert: {
    button: 'Cere revenirea integrării',
    title: 'Ask for the integration to be reverted',
    effect: 'The coordinator will revert this package’s integration on main.',
  },
};

/** Stop / revert requests: a confirm step with an optional note, then the list of what was asked and whether it was picked up. */
export function ControlSection({ taskId, controls }: { taskId: string; controls: ControlRequest[] }) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState<Kind | null>(null);
  const [note, setNote] = useState('');
  const send = useMutation({
    mutationFn: (kind: Kind) => api.post(`/api/tasks/${encodeURIComponent(taskId)}/control`, { kind, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: () => {
      setAsking(null);
      setNote('');
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  return (
    <div className="space-y-3" data-testid="controls">
      <div className="flex flex-wrap gap-2">
        {(Object.keys(KINDS) as Kind[]).map((k) => (
          <Button key={k} variant={k === 'stop' ? 'danger' : 'warn'} disabled={send.isPending} onClick={() => { send.reset(); setAsking(asking === k ? null : k); }} data-testid={`control-${k}`} aria-expanded={asking === k}>
            {KINDS[k].button}
          </Button>
        ))}
      </div>
      {asking && (
        <Card className="space-y-3 border-waiting p-4" data-testid="control-confirm-panel">
          <div className="font-semibold">{KINDS[asking].title}?</div>
          <p className="text-[15px] text-muted">{KINDS[asking].effect} Buildyboy only records the request; it does not run git itself.</p>
          <div>
            <label htmlFor="control-note" className="mb-1 block text-[15px] font-medium">Note (optional)</label>
            <textarea id="control-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={`${inputClass} py-2`} data-testid="control-note" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant={asking === 'stop' ? 'danger' : 'warn'} disabled={send.isPending} onClick={() => send.mutate(asking)} data-testid="control-confirm">
              {send.isPending ? 'Sending…' : 'Send request'}
            </Button>
            <Button onClick={() => setAsking(null)} disabled={send.isPending}>Cancel</Button>
          </div>
          {send.error && <div role="alert" className="text-error">{(send.error as Error).message}</div>}
        </Card>
      )}
      <p className="text-sm text-muted">
        Requests wait for the coordinator, which reads them with <code className="font-mono">control_get</code> and acts. Buildyboy doesn’t run git itself.
      </p>
      {controls.length > 0 && (
        <ul className="space-y-2" data-testid="control-list">
          {controls.map((c) => (
            <li key={c.id} className="rounded-lg border border-line bg-panel p-3" data-testid="control-item" data-kind={c.kind} data-status={c.status}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{c.kind === 'stop' ? 'Stop' : 'Revert integration'}</span>
                <Badge color={c.status === 'open' ? 'var(--bb-waiting)' : 'var(--bb-working)'}>{c.status === 'open' ? 'open' : 'acked'}</Badge>
                <span className="text-sm text-muted">
                  asked <RelTime ts={c.createdAt} />
                  {c.ackedAt ? <> · picked up <RelTime ts={c.ackedAt} /></> : null}
                </span>
              </div>
              {c.note && <p className="mt-1 whitespace-pre-wrap text-[15px] [overflow-wrap:anywhere]">{c.note}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

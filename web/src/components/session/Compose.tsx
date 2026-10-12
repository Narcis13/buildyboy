// Compose box: queue a message for the session (now / after this turn), quick replies, queued state.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueuedMessageView } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { Button, RelTime } from '../ui.tsx';

const QUICK = ['continue', 'run the tests', 'commit and push', 'stop here'];
type Mode = QueuedMessageView['mode'];

export function Compose({ sessionId, queued, disabled }: { sessionId: string; queued: QueuedMessageView[]; disabled?: boolean }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>('after_turn');
  const [showDelivered, setShowDelivered] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['session', sessionId] });
  const send = useMutation({
    mutationFn: (t: string) => api.post<{ id: string }>(`/api/sessions/${sessionId}/messages`, { text: t, mode }),
    onSuccess: () => setText(''),
    onSettled: refresh,
  });
  const cancel = useMutation({ mutationFn: (mid: string) => api.del(`/api/sessions/${sessionId}/messages/${mid}`), onSettled: refresh });

  const waiting = queued.filter((q) => q.status === 'queued');
  const delivered = queued.filter((q) => q.status === 'delivered').slice(0, 5);
  const submit = () => text.trim() && send.mutate(text.trim());

  if (disabled) {
    return (
      <div data-testid="compose" className="shrink-0 rounded-xl border border-dashed border-line px-3 py-2.5 text-[14px] text-muted">
        Session ended · messages can't be delivered. Resume it with <code className="font-mono">claude --resume</code> to continue.
      </div>
    );
  }

  return (
    <div data-testid="compose" className="shrink-0 rounded-xl border border-line bg-panel p-2">
      {waiting.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1">
          {waiting.map((q) => (
            <li key={q.id} data-testid="queued-message" className="flex min-w-0 items-center gap-2 rounded-lg bg-waiting/10 py-1 pl-2.5 pr-1 ring-1 ring-waiting/40">
              <span className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-waiting">{q.mode === 'now' ? 'queued · now' : 'queued · after turn'}</span>
              <span className="min-w-0 flex-1 truncate text-[15px]" title={q.text}>
                {q.text}
              </span>
              <Button size="sm" className="min-h-11 shrink-0" disabled={cancel.isPending} onClick={() => cancel.mutate(q.id)}>
                Cancel
              </Button>
            </li>
          ))}
        </ul>
      )}
      {delivered.length > 0 && (
        <div className="mb-1">
          <button type="button" onClick={() => setShowDelivered(!showDelivered)} className="min-h-11 text-[13px] text-muted hover:text-ink">
            {showDelivered ? '▾' : '▸'} {delivered.length} delivered
          </button>
          {showDelivered && (
            <ul className="mb-1 flex flex-col gap-0.5">
              {delivered.map((q) => (
                <li key={q.id} className="flex min-w-0 items-center gap-2 text-[14px] text-muted">
                  <span className="text-working">✓</span>
                  <span className="min-w-0 flex-1 truncate">{q.text}</span>
                  <span className="shrink-0 font-mono text-[11px]">
                    {q.deliveredVia ?? ''} <RelTime ts={q.deliveredAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="-mx-1 mb-1.5 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5">
        <div role="radiogroup" aria-label="Delivery" className="inline-flex shrink-0 rounded-full border border-line p-0.5" title={mode === 'now' ? 'Delivered at the next tool call' : 'Delivered when Claude finishes the turn'}>
          {(
            [
              ['after_turn', 'After turn'],
              ['now', 'Now'],
            ] as [Mode, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              onClick={() => setMode(id)}
              className={`min-h-11 rounded-full px-3 text-[14px] ${mode === id ? 'bg-accent text-accent-ink' : 'text-muted'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="h-6 w-px shrink-0 bg-line" aria-hidden />
        {QUICK.map((q) => (
          <button
            key={q}
            type="button"
            disabled={disabled || send.isPending}
            onClick={() => send.mutate(q)}
            className="min-h-11 shrink-0 rounded-full border border-line bg-panel-2 px-3.5 text-[14px] hover:border-accent disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          aria-label="Message to the session"
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder={disabled ? 'Session ended' : 'Message Claude…'}
          className="max-h-40 min-h-11 min-w-0 flex-1 resize-y rounded-lg border border-line bg-bg-2 px-3 py-2.5 text-[15px] outline-none focus:border-accent"
        />
        <Button variant="primary" disabled={disabled || !text.trim() || send.isPending} onClick={submit}>
          Send
        </Button>
      </div>
      {send.isError && <div className="mt-1 text-[14px] text-error">{(send.error as Error).message}</div>}
    </div>
  );
}

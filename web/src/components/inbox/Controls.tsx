import { useState } from 'react';
import type { ActionAnswer, PendingActionView } from '../../../../shared/types.ts';
import { Markdown } from '../ui.tsx';
import { Button } from '../settings/Touch.tsx';

export interface ControlProps {
  action: PendingActionView;
  busy: boolean;
  send: (answer: ActionAnswer) => void;
}

const field = 'w-full rounded-lg border border-line bg-bg-2 px-3 py-2.5 text-base outline-none focus:border-accent';

/** kind=permission: Allow once / Allow for this session / Deny with a message / Deny and interrupt. */
export function PermissionControls({ action, busy, send }: ControlProps) {
  const [msg, setMsg] = useState('');
  const hasSuggestions = !!action.request.permissionSuggestions?.length;
  const message = msg.trim() || 'Denied from Buildyboy';
  return (
    <div className="space-y-3">
      <div className={`grid gap-2 ${hasSuggestions ? 'sm:grid-cols-2' : ''}`}>
        <Button variant="ok" size="lg" disabled={busy} data-testid="answer-allow" onClick={() => send({ type: 'allow' })}>
          Allow once
        </Button>
        {hasSuggestions && (
          <Button variant="primary" size="lg" disabled={busy} data-testid="answer-allow-session" onClick={() => send({ type: 'allow', scope: 'session' })}>
            Allow for this session
          </Button>
        )}
      </div>
      <div className="space-y-2 rounded-lg border border-line p-3">
        <label className="block text-sm text-muted" htmlFor={`deny-${action.id}`}>Tell Claude why (optional)</label>
        <textarea id={`deny-${action.id}`} rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="e.g. Use the staging script instead" className={field} data-testid="deny-message" />
        <div className="grid grid-cols-2 gap-2">
          <Button variant="warn" disabled={busy} data-testid="answer-deny" onClick={() => send({ type: 'deny', message })}>
            Deny
          </Button>
          <Button variant="danger" disabled={busy} data-testid="answer-deny-interrupt" onClick={() => send({ type: 'deny', message, interrupt: true })}>
            Deny and interrupt
          </Button>
        </div>
      </div>
    </div>
  );
}

interface Question {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

const OTHER = '__other__';

/** kind=question: AskUserQuestion. Tap options or type "Other". */
export function QuestionControls({ action, busy, send }: ControlProps) {
  const questions = ((action.request.toolInput?.questions as Question[] | undefined) ?? []).filter((q) => q && typeof q.question === 'string');
  // per question: chosen labels (plus OTHER) and the typed text
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  const toggle = (q: Question, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      if (!q.multiSelect) return { ...p, [q.question]: [label] };
      return { ...p, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
    });

  const answerFor = (q: Question): string | null => {
    const cur = picked[q.question] ?? [];
    const parts = cur.filter((l) => l !== OTHER);
    if (cur.includes(OTHER)) {
      const t = (typed[q.question] ?? '').trim();
      if (!t) return null;
      parts.push(t);
    }
    return parts.length ? parts.join(', ') : null;
  };
  const complete = questions.length > 0 && questions.every((q) => answerFor(q) != null);

  return (
    <div className="space-y-4">
      {questions.map((q, qi) => {
        const cur = picked[q.question] ?? [];
        return (
          <fieldset key={qi} className="space-y-2" data-testid="question">
            <legend className="mb-1 w-full">
              {q.header && <span className="mr-2 rounded border border-line px-1.5 py-0.5 font-mono text-xs uppercase tracking-wider text-muted">{q.header}</span>}
              <span className="text-base font-medium">{q.question}</span>
              {q.multiSelect && <span className="ml-2 text-sm text-muted">(choose any)</span>}
            </legend>
            {(q.options ?? []).map((o) => {
              const on = cur.includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  role={q.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  disabled={busy}
                  data-testid="question-option"
                  onClick={() => toggle(q, o.label)}
                  className={`flex min-h-12 w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition ${on ? 'border-accent bg-panel-2' : 'border-line hover:border-accent'}`}
                >
                  <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center border-2 ${q.multiSelect ? 'rounded' : 'rounded-full'} ${on ? 'border-accent bg-accent text-accent-ink' : 'border-muted'}`}>
                    {on && <span className="text-xs leading-none">✓</span>}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-base font-medium">{o.label}</span>
                    {o.description && <span className="block text-sm text-muted">{o.description}</span>}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              role={q.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={cur.includes(OTHER)}
              disabled={busy}
              data-testid="question-other"
              onClick={() => toggle(q, OTHER)}
              className={`flex min-h-12 w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-base transition ${cur.includes(OTHER) ? 'border-accent bg-panel-2' : 'border-line hover:border-accent'}`}
            >
              <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center border-2 ${q.multiSelect ? 'rounded' : 'rounded-full'} ${cur.includes(OTHER) ? 'border-accent bg-accent text-accent-ink' : 'border-muted'}`}>
                {cur.includes(OTHER) && <span className="text-xs leading-none">✓</span>}
              </span>
              Other…
            </button>
            {cur.includes(OTHER) && (
              <input
                type="text"
                autoFocus
                aria-label={`Your answer to: ${q.question}`}
                value={typed[q.question] ?? ''}
                onChange={(e) => setTyped((t) => ({ ...t, [q.question]: e.target.value }))}
                placeholder="Type your answer"
                className={field}
                data-testid="question-other-text"
              />
            )}
          </fieldset>
        );
      })}
      {questions.length === 0 && <div className="text-muted">This question has no options to show. Open the session to answer it.</div>}
      <Button
        variant="ok"
        size="lg"
        className="w-full"
        disabled={busy || !complete}
        data-testid="answer-submit"
        onClick={() => {
          const answers: Record<string, string> = {};
          for (const q of questions) answers[q.question] = answerFor(q)!;
          send({ type: 'answers', answers });
        }}
      >
        Send answer
      </Button>
    </div>
  );
}

/** kind=plan: ExitPlanMode. Approve, or reject with feedback. */
export function PlanControls({ action, busy, send }: ControlProps) {
  const [feedback, setFeedback] = useState('');
  const plan = typeof action.request.toolInput?.plan === 'string' ? (action.request.toolInput.plan as string) : '';
  return (
    <div className="space-y-3">
      <div className="max-h-[50vh] overflow-auto rounded-lg border border-line bg-bg-2 p-3" data-testid="plan-body">
        {plan ? <Markdown text={plan} /> : <span className="text-muted">The plan text was not included in the request.</span>}
      </div>
      <Button variant="ok" size="lg" className="w-full" disabled={busy} data-testid="answer-approve" onClick={() => send({ type: 'allow' })}>
        Approve plan
      </Button>
      <div className="space-y-2 rounded-lg border border-line p-3">
        <label className="block text-sm text-muted" htmlFor={`fb-${action.id}`}>What should change?</label>
        <textarea id={`fb-${action.id}`} rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Feedback for Claude" className={field} data-testid="plan-feedback" />
        <Button variant="warn" className="w-full" disabled={busy} data-testid="answer-reject" onClick={() => send({ type: 'deny', message: feedback.trim() || 'Plan rejected from Buildyboy. Please revise it.' })}>
          Reject with feedback
        </Button>
      </div>
    </div>
  );
}

const QUICK = ['continue', 'run the tests', 'commit and push', 'stop here'];

/** kind=stop_wait: the turn finished while walk mode is on. */
export function StopWaitControls({ action, busy, send }: ControlProps) {
  const [text, setText] = useState('');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" data-testid="quick-replies">
        {QUICK.map((q) => (
          <Button key={q} disabled={busy} className="flex-1 whitespace-nowrap" data-testid="quick-reply" onClick={() => send({ type: 'reply', text: q })}>
            {q}
          </Button>
        ))}
      </div>
      <div className="space-y-2">
        <label className="block text-sm text-muted" htmlFor={`reply-${action.id}`}>Or tell Claude what to do next</label>
        <textarea id={`reply-${action.id}`} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Next instruction" className={field} data-testid="reply-text" />
        <Button variant="primary" size="lg" className="w-full" disabled={busy || !text.trim()} data-testid="answer-reply" onClick={() => send({ type: 'reply', text: text.trim() })}>
          Send reply
        </Button>
      </div>
      <Button variant="ghost" className="w-full" disabled={busy} data-testid="answer-release" onClick={() => send({ type: 'release' })}>
        Let it go idle
      </Button>
    </div>
  );
}

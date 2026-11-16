// The planner (SPEC §12.6) in the PWA: the "Plan new work" form (goal and notes → POST …/plan) and the project's recent plans.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PlanStatus, PlanView } from '../../../../shared/factory.ts';
import { api } from '../../lib/api.ts';
import { Badge, Button, Card, RelTime } from '../ui.tsx';
import { Field, inputClass } from '../settings/bits.tsx';
import { Section } from '../factory/common.tsx';

const textareaClass = `${inputClass} py-2 leading-snug`;

/** An inline form: what to build (3–4000 characters) and optional notes. Closes itself when the plan is started. */
export function PlanForm({ projectKey, onClose }: { projectKey: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [goal, setGoal] = useState('');
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const goalRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    root.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    goalRef.current?.focus({ preventScroll: true });
  }, []);
  const send = useMutation({
    mutationFn: (b: { goal: string; notes?: string }) => api.post<PlanView>(`/api/factory/projects/${encodeURIComponent(projectKey)}/plan`, b),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['factory-project', projectKey] });
      qc.invalidateQueries({ queryKey: ['factory-projects'] });
      onClose();
    },
  });
  const trimmed = goal.trim();
  const goalError = trimmed.length < 3 ? 'Say what to build (at least 3 characters).' : trimmed.length > 4000 ? 'The goal is longer than 4000 characters.' : null;
  const submit = () => {
    setTouched(true);
    if (goalError) return;
    send.mutate({ goal: trimmed, ...(notes.trim() ? { notes: notes.trim() } : {}) });
  };
  return (
    <div ref={root} className="mt-3 space-y-3 rounded-lg border border-line bg-panel-2 p-3" data-testid="plan-form">
      <Field label="Goal" htmlFor="plan-goal" hint={touched && goalError ? undefined : 'The planner reads the repository and proposes packages; you approve them before anything starts.'}>
        <textarea
          id="plan-goal"
          ref={goalRef}
          rows={3}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          aria-invalid={touched && !!goalError}
          className={textareaClass}
          placeholder="What should get built?"
          data-testid="plan-goal"
        />
        {touched && goalError && <p role="alert" className="mt-1 text-sm text-error" data-testid="plan-goal-error">{goalError}</p>}
      </Field>
      <Field label="Notes (optional)" htmlFor="plan-notes">
        <textarea id="plan-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={textareaClass} data-testid="plan-notes" />
      </Field>
      {send.error && <div role="alert" className="text-error [overflow-wrap:anywhere]" data-testid="plan-error">{(send.error as Error).message}</div>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={send.isPending} onClick={submit} data-testid="plan-submit">{send.isPending ? 'Starting…' : 'Start planning'}</Button>
        <Button size="sm" disabled={send.isPending} onClick={onClose} data-testid="plan-cancel">Cancel</Button>
      </div>
    </div>
  );
}

const PLAN_COLOR: Record<PlanStatus, string> = {
  running: 'var(--bb-working)',
  proposed: 'var(--bb-waiting)',
  approved: 'var(--bb-idle)',
  discarded: 'var(--bb-ended)',
  failed: 'var(--bb-error)',
  cancelled: 'var(--bb-ended)',
};

function PlanRow({ pl }: { pl: PlanView }) {
  const why = pl.status === 'failed' ? pl.error ?? pl.questions[0] : null;
  return (
    <Card className="space-y-1.5 p-3" data-testid="plan-row" data-plan={pl.id} data-status={pl.status}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge color={PLAN_COLOR[pl.status]} className="normal-case">{pl.status}</Badge>
        {pl.packages.length > 0 && <span className="text-sm text-muted">{pl.packages.length} package{pl.packages.length === 1 ? '' : 's'}</span>}
        <span className="ml-auto text-sm text-muted"><RelTime ts={pl.createdAt} /></span>
      </div>
      <div className="line-clamp-3 text-[15px] leading-snug [overflow-wrap:anywhere]" title={pl.goal}>{pl.goal}</div>
      {why && <div className="line-clamp-3 text-sm text-error [overflow-wrap:anywhere]" data-testid="plan-why">{why}</div>}
      {pl.status === 'failed' && pl.error && pl.questions.length > 0 && (
        <div className="line-clamp-2 text-sm text-muted [overflow-wrap:anywhere]">{pl.questions.length} question{pl.questions.length === 1 ? '' : 's'}: {pl.questions[0]}</div>
      )}
    </Card>
  );
}

export function PlansSection({ plans }: { plans: PlanView[] }) {
  if (!plans.length) return null;
  return (
    <Section title="Plans" count={plans.length} testId="project-plans">
      <ul className="flex flex-col gap-2">
        {plans.map((pl) => (
          <li key={pl.id}>
            <PlanRow pl={pl} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

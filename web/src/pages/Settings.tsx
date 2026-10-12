import { useState } from 'react';
import { PageTitle, Toggle } from '../components/ui.tsx';
import { Button } from '../components/settings/Touch.tsx';
import { DevicesSection, PasswordSection } from '../components/settings/AccountSections.tsx';
import { Field, inputClass, NumberField, SaveButton, SectionCard } from '../components/settings/bits.tsx';
import { NotificationsSection } from '../components/settings/NotificationsSection.tsx';
import { RedactionEditor } from '../components/settings/RedactionEditor.tsx';
import { SnippetsSection } from '../components/settings/Snippets.tsx';
import { useSettings, type SettingsData } from '../components/settings/useSettings.ts';

const WATCHERS: { id: 'stale' | 'loop' | 'budget' | 'context' | 'harness'; label: string; hint: string }[] = [
  { id: 'stale', label: 'Stale', hint: 'No event for 10 minutes while working' },
  { id: 'loop', label: 'Loop suspicion', hint: 'Same failing call 3+ times, or 15 turns with no file changes' },
  { id: 'budget', label: 'Budget', hint: 'A session or job passes its cost threshold' },
  { id: 'context', label: 'Context', hint: 'Context window above the threshold below' },
  { id: 'harness', label: 'Harness alignment', hint: 'PROGRESS.md Next unchanged for 60 minutes, or a Limit reached' },
];

/** Defaults, retention, budgets and the smart watchers. */
function LimitsSection({ data }: { data: SettingsData }) {
  const { save } = useSettings();
  const [stopWait, setStopWait] = useState(data.stop_wait_min);
  const [retention, setRetention] = useState(data.retention_days);
  const [budgetSession, setBudgetSession] = useState(data.budget_session_usd);
  const [budgetJob, setBudgetJob] = useState(data.budget_job_usd);
  const [ctxPct, setCtxPct] = useState(data.context_threshold_pct);
  const [watchers, setWatchers] = useState<Record<string, boolean>>(() => Object.fromEntries(WATCHERS.map((w) => [w.id, data.watchers?.[w.id] !== false])));
  const badPct = ctxPct != null && (ctxPct < 1 || ctxPct > 100);
  return (
    <SectionCard title="Budgets, retention and watchers" testId="settings-limits">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Hold at Stop (minutes)" htmlFor="stop-wait" hint="While walk mode is on, a finished turn waits this long for your next instruction. Default 5.">
          <NumberField id="stop-wait" value={stopWait} onChange={setStopWait} step={0.5} placeholder="5" />
        </Field>
        <Field label="Keep raw events (days)" htmlFor="retention" hint="Older events and job output are purged nightly. Sessions and messages stay. Default 90.">
          <NumberField id="retention" value={retention} onChange={setRetention} min={1} placeholder="90" />
        </Field>
        <Field label="Session budget (USD)" htmlFor="budget-session" hint="Notify when one session costs more than this. Empty for no limit.">
          <NumberField id="budget-session" value={budgetSession} onChange={setBudgetSession} step={0.5} />
        </Field>
        <Field label="Job budget (USD)" htmlFor="budget-job" hint="Notify when one job costs more than this. Empty for no limit.">
          <NumberField id="budget-job" value={budgetJob} onChange={setBudgetJob} step={0.5} />
        </Field>
        <Field label="Context threshold (%)" htmlFor="ctx-pct" hint="The context watcher fires above this. Default 85.">
          <NumberField id="ctx-pct" value={ctxPct} onChange={setCtxPct} min={1} placeholder="85" />
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1 text-[15px] font-medium">Smart watchers</legend>
        <div className="space-y-1">
          {WATCHERS.map((w) => (
            <div key={w.id}>
              <Toggle on={watchers[w.id]} onChange={(v) => setWatchers((s) => ({ ...s, [w.id]: v }))} label={w.label} />
              <p className="-mt-1 pl-[3.25rem] text-sm text-muted">{w.hint}</p>
            </div>
          ))}
        </div>
      </fieldset>
      {badPct && <div className="text-waiting">The context threshold is a percentage from 1 to 100.</div>}
      <SaveButton
        testId="limits-save"
        pending={save.isPending}
        error={save.error as Error | null}
        disabled={badPct}
        onSave={() => save.mutate({ stop_wait_min: stopWait, retention_days: retention, budget_session_usd: budgetSession, budget_job_usd: budgetJob, context_threshold_pct: ctxPct, watchers })}
      />
    </SectionCard>
  );
}

/** Write-only: the server only ever returns a mask. */
function GithubSection({ data }: { data: SettingsData }) {
  const { save } = useSettings();
  const [token, setToken] = useState('');
  const isSet = !!data.github_token;
  return (
    <SectionCard title="GitHub" hint="A fine-grained, read-only token lets Buildyboy follow pull requests and their checks (polled every 2 minutes). Optional." testId="settings-github">
      <Field label="Personal access token" htmlFor="github-token" hint={isSet ? 'A token is saved. Type a new one to replace it.' : 'Needs read access to pull requests, checks and contents.'}>
        <input id="github-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={isSet ? data.github_token! : 'github_pat_…'} className={`${inputClass} font-mono`} data-testid="github-token" />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <SaveButton testId="github-save" pending={save.isPending} error={save.error as Error | null} disabled={!token.trim()} onSave={() => save.mutate({ github_token: token.trim() }, { onSuccess: () => setToken('') })} />
        {isSet && <Button variant="danger" disabled={save.isPending} onClick={() => save.mutate({ github_token: null })} data-testid="github-remove">Remove token</Button>}
      </div>
    </SectionCard>
  );
}

export default function Settings() {
  const { data, isLoading, error } = useSettings();
  return (
    <div data-testid="settings-page" className="mx-auto max-w-6xl">
      <PageTitle>Settings</PageTitle>
      {error && <div role="alert" className="mb-3 text-error">Could not load settings: {(error as Error).message}</div>}
      {isLoading && <div className="text-muted">Loading…</div>}
      {data && (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-4">
            <NotificationsSection data={data} />
            <LimitsSection data={data} />
            <GithubSection data={data} />
          </div>
          <div className="min-w-0 space-y-4">
            <SnippetsSection publicUrl={data.public_url} />
            <RedactionEditor data={data} />
            <PasswordSection />
            <DevicesSection />
          </div>
        </div>
      )}
    </div>
  );
}

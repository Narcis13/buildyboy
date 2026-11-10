// Settings → Factory: gate rounds and, per repo, where the gate recipe runs and which resources packages get.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FactoryConfig, RepoFactoryConfig } from '../../../../shared/factory.ts';
import type { MachineSummary } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { Field, inputClass, NumberField, SaveButton, SectionCard } from '../settings/bits.tsx';
import { Button } from '../settings/Touch.tsx';

const blank = (): RepoFactoryConfig => ({
  repo: '',
  machineId: null,
  checkout: '',
  recipe: '',
  worktree: '',
  portFrom: null,
  portTo: null,
  dbPrefix: '',
  migrationFrom: null,
  migrationBlock: 10,
  cleanup: [],
});

type TextKey = 'repo' | 'checkout' | 'recipe' | 'worktree' | 'dbPrefix';

function RepoEditor({ r, i, machines, onChange, onRemove }: { r: RepoFactoryConfig; i: number; machines: MachineSummary[]; onChange: (r: RepoFactoryConfig) => void; onRemove: () => void }) {
  const set = <K extends keyof RepoFactoryConfig>(k: K, v: RepoFactoryConfig[K]) => onChange({ ...r, [k]: v });
  const id = (n: string) => `fc-${i}-${n}`;
  const text = (k: TextKey, label: string, placeholder?: string, hint?: string) => (
    <Field label={label} htmlFor={id(k)} hint={hint}>
      <input id={id(k)} value={r[k]} onChange={(e) => set(k, e.target.value)} placeholder={placeholder} className={inputClass} data-testid={`fc-${k}`} />
    </Field>
  );
  return (
    <div className="space-y-4 rounded-lg border border-line p-3" data-testid="fc-repo-block" data-repo={r.repo}>
      <div className="grid gap-4 sm:grid-cols-2">
        {text('repo', 'Repo', 'buildyboy', 'Matches the repo of a package, ignoring case.')}
        <Field label="Machine" htmlFor={id('machine')} hint="Its runner runs the gates.">
          <select id={id('machine')} value={r.machineId ?? ''} onChange={(e) => set('machineId', e.target.value || null)} className={inputClass} data-testid="fc-machine">
            <option value="">None</option>
            {r.machineId && !machines.some((m) => m.id === r.machineId) && <option value={r.machineId}>{r.machineId} (unknown)</option>}
            {machines
              .filter((m) => !m.revoked || m.id === r.machineId)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.runnerOnline ? '' : ' (runner offline)'}
                </option>
              ))}
          </select>
        </Field>
        {text('checkout', 'Main checkout', 'C:\\work\\buildyboy', 'The trusted checkout on that machine; the recipe is read from here.')}
        {text('recipe', 'Recipe', 'factory/gates.json', 'Relative to the checkout.')}
        {text('worktree', 'Worktree', 'C:\\work\\wt\\{idLower}', 'Placeholders: {id}, {idLower}.')}
        {text('dbPrefix', 'Database prefix', 'bb_', 'Letters, digits, _ and - only.')}
        <Field label="Port from" htmlFor={id('portFrom')}>
          <NumberField id={id('portFrom')} value={r.portFrom} onChange={(v) => set('portFrom', v)} min={1} placeholder="4100" />
        </Field>
        <Field label="Port to" htmlFor={id('portTo')}>
          <NumberField id={id('portTo')} value={r.portTo} onChange={(v) => set('portTo', v)} min={1} placeholder="4199" />
        </Field>
        <Field label="Migrations start at" htmlFor={id('migrationFrom')} hint="Empty means packages get no migration range.">
          <NumberField id={id('migrationFrom')} value={r.migrationFrom} onChange={(v) => set('migrationFrom', v)} min={0} placeholder="100" />
        </Field>
        <Field label="Migration block size" htmlFor={id('migrationBlock')}>
          <NumberField id={id('migrationBlock')} value={r.migrationBlock} onChange={(v) => set('migrationBlock', v ?? 10)} min={1} />
        </Field>
      </div>
      <Field label="Cleanup lines" htmlFor={id('cleanup')} hint="One per line, returned when a package is integrated. Placeholders as above.">
        <textarea id={id('cleanup')} rows={3} value={r.cleanup.join('\n')} onChange={(e) => set('cleanup', e.target.value.split('\n'))} className={`${inputClass} py-2 font-mono text-sm`} data-testid="fc-cleanup" />
      </Field>
      <Button variant="danger" onClick={onRemove} data-testid="fc-remove">Remove repo</Button>
    </div>
  );
}

export function FactoryConfigCard() {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ['factory-config'], queryFn: () => api.get<FactoryConfig>('/api/factory/config') });
  const machines = useQuery({ queryKey: ['machines'], queryFn: () => api.get<MachineSummary[]>('/api/machines') });
  const [maxRounds, setMaxRounds] = useState<number | null>(3);
  const [repos, setRepos] = useState<RepoFactoryConfig[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (cfg.data && !loaded) {
      setMaxRounds(cfg.data.maxRounds);
      setRepos(cfg.data.repos);
      setLoaded(true);
    }
  }, [cfg.data, loaded]);
  const save = useMutation({
    mutationFn: () =>
      api.put<FactoryConfig>('/api/factory/config', {
        maxRounds: maxRounds ?? 3,
        // blank cleanup lines are noise
        repos: repos.map((r) => ({ ...r, repo: r.repo.trim(), cleanup: r.cleanup.map((l) => l.trim()).filter(Boolean) })),
      }),
    onSuccess: (c) => {
      setRepos(c.repos);
      setMaxRounds(c.maxRounds);
      qc.setQueryData(['factory-config'], c);
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const badRounds = maxRounds == null || maxRounds < 1 || !Number.isInteger(maxRounds);
  const blankRepo = repos.some((r) => !r.repo.trim());
  return (
    <SectionCard
      title="Factory: gates and repos"
      hint="How many gate rounds a package gets, and for each repo the machine that runs its gates, the recipe, and the port, database and migration range tasks_claim hands out."
      testId="settings-factory-config"
    >
      {cfg.isLoading && <div className="text-muted">Loading…</div>}
      {cfg.error && <div role="alert" className="text-error">Could not load the config: {(cfg.error as Error).message}</div>}
      {loaded && (
        <>
          <Field label="Max gate rounds" htmlFor="fc-max-rounds" hint="A package that fails its last round is blocked until you approve one more.">
            <div className="sm:max-w-[12rem]">
              <NumberField id="fc-max-rounds" value={maxRounds} onChange={setMaxRounds} min={1} placeholder="3" />
            </div>
          </Field>
          {repos.length === 0 && <div className="text-muted">No repo is configured.</div>}
          {repos.map((r, i) => (
            <RepoEditor key={i} r={r} i={i} machines={machines.data ?? []} onChange={(n) => setRepos((rs) => rs.map((x, j) => (j === i ? n : x)))} onRemove={() => setRepos((rs) => rs.filter((_, j) => j !== i))} />
          ))}
          <div>
            <Button onClick={() => setRepos((rs) => [...rs, blank()])} data-testid="fc-add">Add repo</Button>
          </div>
          {badRounds && <div className="text-waiting">Gate rounds is a whole number, at least 1.</div>}
          {blankRepo && <div className="text-waiting">Every repo needs a name.</div>}
          <SaveButton testId="fc-save" pending={save.isPending} error={save.error as Error | null} disabled={badRounds || blankRepo} onSave={() => save.mutate()} />
        </>
      )}
    </SectionCard>
  );
}

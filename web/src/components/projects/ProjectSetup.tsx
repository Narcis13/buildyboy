// A project's Setup tab: where its line runs (machine, checkout, line file), its id prefix, the owner's overrides that
// win over the line file (limits, models, integration approval), the §11.7 allocation fields of a migrated project, and
// "Check setup" with the resolved line as the runner last reported it.
import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ID_PREFIX_RE, MODEL_ROLES, type LegacyRepoConfig, type ModelRole, type ProjectConfig, type ProjectDetail, type ProjectView } from '../../../../shared/factory.ts';
import { api } from '../../lib/api.ts';
import { navigate } from '../../lib/router.tsx';
import { Button, Card, RelTime } from '../ui.tsx';
import { Field, inputClass, NumberField, SaveButton } from '../settings/bits.tsx';
import { openCount, useProjectAction } from '../factory/projects.tsx';
import { MachineSelect } from './NewProjectForm.tsx';

const MODEL_DEFAULT: Record<ModelRole, string> = { worker: 'opus', qa: 'opus', review: 'opus', visual: 'sonnet', foreman: 'opus', planner: 'opus' };
const MODEL_LABEL: Record<ModelRole, string> = { worker: 'Worker', qa: 'QA', review: 'Reviewer (G3)', visual: 'Visual judge (G4)', foreman: 'Foreman', planner: 'Planner' };
type Approval = '' | 'never' | 'sensitive' | 'always';

function Group({ title, hint, children, testId }: { title: string; hint?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <Card className="min-w-0 space-y-4 p-4" data-testid={testId}>
      <div>
        <h2 className="text-base font-semibold tracking-wide">{title}</h2>
        {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

/** The resolved line, as nested label/value pairs rather than raw JSON. */
function Readable({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value == null || value === '') return <span className="text-muted">—</span>;
  if (typeof value !== 'object') return <span className="font-mono text-sm [overflow-wrap:anywhere]">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.every((v) => v == null || typeof v !== 'object')) return <span className="font-mono text-sm [overflow-wrap:anywhere]">{value.length ? value.join(' ') : '[]'}</span>;
    return (
      <ul className="space-y-1">
        {value.map((v, i) => (
          <li key={i}>
            <Readable value={v} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  if (depth > 3) return <code className="font-mono text-sm [overflow-wrap:anywhere]">{JSON.stringify(value)}</code>;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return <span className="text-muted">{'{}'}</span>;
  return (
    <dl className={depth ? 'space-y-1 border-l border-line pl-3' : 'space-y-2'}>
      {entries.map(([k, v]) => (
        <div key={k} className={v && typeof v === 'object' && !Array.isArray(v) ? '' : 'flex flex-wrap gap-x-2'}>
          <dt className="text-sm text-muted">{k}</dt>
          <dd className="min-w-0">
            <Readable value={v} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CheckSetup({ p }: { p: ProjectView }) {
  const act = useProjectAction(p.key);
  const [note, setNote] = useState<string | null>(null);
  return (
    <Group
      title="Line"
      hint={<>The runner reads the line file in the main checkout and reports the resolved line: with every package it prepares, and when you check the setup.</>}
      testId="setup-line"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={act.isPending}
          onClick={() =>
            act.mutate(
              { action: 'refresh' },
              {
                onSuccess: (r) => {
                  const x = r as { sent?: boolean; reason?: string };
                  setNote(x.sent === false ? `Nothing was sent: ${x.reason ?? 'the runner did not take it'}.` : x.sent ? 'Asked the runner; the result shows up here.' : 'Checked.');
                },
              },
            )
          }
          data-testid="setup-check"
        >
          {act.isPending ? 'Checking…' : 'Check setup'}
        </Button>
        {note && <span role="status" className="text-[15px] text-muted" data-testid="setup-check-result">{note}</span>}
        {act.error && <span role="alert" className="text-error">{(act.error as Error).message}</span>}
      </div>
      {p.lineError && (
        <div role="alert" className="whitespace-pre-wrap rounded-lg border border-error p-3 text-[15px] text-error [overflow-wrap:anywhere]" data-testid="setup-line-error">
          {p.lineError}
        </div>
      )}
      {p.resolvedLine != null ? (
        <div data-testid="setup-resolved-line">
          <div className="mb-2 text-sm text-muted">
            Reported <RelTime ts={p.lineSeenAt} />
          </div>
          <Readable value={p.resolvedLine} />
        </div>
      ) : (
        <p className="text-[15px] text-muted" data-testid="setup-no-line">The runner has not reported this project's line yet.</p>
      )}
    </Group>
  );
}

const numOrUndef = (v: number | null) => (v == null || !Number.isFinite(v) ? undefined : v);

export function ProjectSetup({ p }: { p: ProjectDetail }) {
  const qc = useQueryClient();
  const hasPackages = openCount(p) + p.archived > 0;
  const c: ProjectConfig = p.config ?? {};
  const [name, setName] = useState(p.name);
  const [repo, setRepo] = useState(p.repo ?? '');
  const [machineId, setMachineId] = useState(p.machineId ?? '');
  const [checkout, setCheckout] = useState(p.checkout ?? '');
  const [lineFile, setLineFile] = useState(p.lineFile);
  const [idPrefix, setIdPrefix] = useState(p.idPrefix);
  const [workers, setWorkers] = useState<number | null>(c.limits?.workers ?? null);
  const [rounds, setRounds] = useState<number | null>(c.limits?.rounds ?? null);
  const [approval, setApproval] = useState<Approval>(c.integrate?.approval ?? '');
  const [models, setModels] = useState<Record<ModelRole, string>>(
    () => Object.fromEntries(MODEL_ROLES.map((r) => [r, c.models?.[r] === null ? 'off' : (c.models?.[r] ?? '')])) as Record<ModelRole, string>,
  );
  const [legacy, setLegacy] = useState<LegacyRepoConfig | null>(c.legacy ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const m = Object.fromEntries(
        MODEL_ROLES.filter((r) => models[r].trim()).map((r) => [r, models[r].trim().toLowerCase() === 'off' ? null : models[r].trim()]),
      );
      const limits = { workers: numOrUndef(workers), rounds: numOrUndef(rounds) };
      return api.put<ProjectView>(`/api/factory/projects/${encodeURIComponent(p.key)}`, {
        name: name.trim(),
        repo: repo.trim() || null,
        machineId: machineId || null,
        checkout: checkout.trim() || null,
        lineFile: lineFile.trim() || 'factory.json',
        ...(hasPackages ? {} : { idPrefix }),
        config: {
          limits: limits.workers != null || limits.rounds != null ? limits : null,
          models: Object.keys(m).length ? m : null,
          integrate: approval ? { approval } : null,
          ...(legacy ? { legacy: { ...legacy, worktree: legacy.worktree.trim(), cleanup: legacy.cleanup.map((l) => l.trim()).filter(Boolean) } } : {}),
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['factory-project', p.key] });
      qc.invalidateQueries({ queryKey: ['factory-projects'] });
    },
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/factory/projects/${encodeURIComponent(p.key)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['factory-projects'] });
      navigate('/projects');
    },
  });

  const prefixProblem = ID_PREFIX_RE.test(idPrefix) ? null : 'Empty, or upper-case letters and digits ending in “-”, e.g. ED-.';
  const badNumbers = [workers, rounds].some((v) => v != null && (!Number.isInteger(v) || v < 1));
  const setL = <K extends keyof LegacyRepoConfig>(k: K, v: LegacyRepoConfig[K]) => setLegacy((l) => (l ? { ...l, [k]: v } : l));
  const mono = `${inputClass} font-mono`;

  return (
    <div className="space-y-4" data-testid="project-setup">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Group title="Project" testId="setup-project">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="ps-name">
              <input id="ps-name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} maxLength={120} data-testid="ps-name" />
            </Field>
            <Field label="Key" htmlFor="ps-key" hint="Never changes.">
              <input id="ps-key" value={p.key} readOnly className={`${mono} text-muted`} />
            </Field>
            <Field label="Repository" htmlFor="ps-repo" hint="owner/name on GitHub.">
              <input id="ps-repo" value={repo} onChange={(e) => setRepo(e.target.value)} className={mono} placeholder="owner/name" autoCapitalize="off" spellCheck={false} data-testid="ps-repo" />
            </Field>
            <Field label="Id prefix" htmlFor="ps-prefix" hint={hasPackages ? 'Fixed: the project has packages.' : (prefixProblem ?? 'Package ids start with it (P1 → ED-P1).')}>
              <input
                id="ps-prefix"
                value={idPrefix}
                readOnly={hasPackages}
                onChange={(e) => setIdPrefix(e.target.value.toUpperCase())}
                className={`${mono} ${hasPackages ? 'text-muted' : ''}`}
                placeholder={hasPackages ? 'none' : 'ED-'}
                maxLength={9}
                data-testid="ps-prefix"
              />
            </Field>
          </div>
        </Group>

        <Group title="Where the line runs" hint="Only you (or an operator) set these: they decide what the runner executes." testId="setup-where">
          <Field label="Machine" htmlFor="ps-machine" hint="Its runner runs the steps and the gates.">
            <MachineSelect id="ps-machine" value={machineId} onChange={setMachineId} />
          </Field>
          <Field label="Main checkout" htmlFor="ps-checkout" hint="The trusted checkout on that machine; never a worktree.">
            <input id="ps-checkout" value={checkout} onChange={(e) => setCheckout(e.target.value)} className={mono} placeholder="C:\work\shop-api" spellCheck={false} data-testid="ps-checkout" />
          </Field>
          <Field label="Line file" htmlFor="ps-line" hint="Relative to the checkout.">
            <input id="ps-line" value={lineFile} onChange={(e) => setLineFile(e.target.value)} className={mono} placeholder="factory.json" spellCheck={false} data-testid="ps-line" />
          </Field>
        </Group>

        <Group title="Overrides" hint="They win over the line file. Empty uses the line file's value (or its default)." testId="setup-overrides">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="Parallel packages" htmlFor="ps-workers">
              <NumberField id="ps-workers" value={workers} onChange={setWorkers} min={1} placeholder="2" />
            </Field>
            <Field label="Gate rounds" htmlFor="ps-rounds">
              <NumberField id="ps-rounds" value={rounds} onChange={setRounds} min={1} placeholder="global" />
            </Field>
            <div className="col-span-2 sm:col-span-1">
            <Field label="Ask before G5" htmlFor="ps-approval">
              <select id="ps-approval" value={approval} onChange={(e) => setApproval(e.target.value as Approval)} className={inputClass} data-testid="ps-approval">
                <option value="">Line file (sensitive)</option>
                <option value="never">Never</option>
                <option value="sensitive">Sensitive packages</option>
                <option value="always">Always</option>
              </select>
            </Field>
            </div>
          </div>
          <fieldset>
            <legend className="mb-1 text-[15px] font-medium">Models</legend>
            <p className="mb-2 text-sm text-muted">“off” turns a role off; without a foreman every question goes to you.</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {MODEL_ROLES.map((r) => (
                <Field key={r} label={MODEL_LABEL[r]} htmlFor={`ps-model-${r}`}>
                  <input
                    id={`ps-model-${r}`}
                    value={models[r]}
                    onChange={(e) => setModels((m) => ({ ...m, [r]: e.target.value }))}
                    className={mono}
                    placeholder={MODEL_DEFAULT[r]}
                    autoCapitalize="off"
                    spellCheck={false}
                    data-testid={`ps-model-${r}`}
                  />
                </Field>
              ))}
            </div>
          </fieldset>
        </Group>

        {legacy && (
          <Group
            title="Allocation (from the repo config)"
            hint="This project came from Settings → Factory's per-repo config. tasks_claim hands these out until the line file declares its own resources."
            testId="setup-legacy"
          >
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Field label="Worktree" htmlFor="ps-worktree" hint="Placeholders: {id}, {idLower}, {localId}, {project}…">
                  <input id="ps-worktree" value={legacy.worktree} onChange={(e) => setL('worktree', e.target.value)} className={mono} spellCheck={false} data-testid="ps-worktree" />
                </Field>
              </div>
              <div className="col-span-2">
                <Field label="Database prefix" htmlFor="ps-db" hint="Letters, digits, _ and - only.">
                  <input id="ps-db" value={legacy.dbPrefix} onChange={(e) => setL('dbPrefix', e.target.value)} className={mono} spellCheck={false} data-testid="ps-db" />
                </Field>
              </div>
              <Field label="Port from" htmlFor="ps-port-from">
                <NumberField id="ps-port-from" value={legacy.portFrom} onChange={(v) => setL('portFrom', v)} min={1} />
              </Field>
              <Field label="Port to" htmlFor="ps-port-to">
                <NumberField id="ps-port-to" value={legacy.portTo} onChange={(v) => setL('portTo', v)} min={1} />
              </Field>
              <Field label="Migrations start at" htmlFor="ps-mig-from" hint="Empty: no migration range.">
                <NumberField id="ps-mig-from" value={legacy.migrationFrom} onChange={(v) => setL('migrationFrom', v)} min={0} />
              </Field>
              <Field label="Migration block size" htmlFor="ps-mig-block">
                <NumberField id="ps-mig-block" value={legacy.migrationBlock} onChange={(v) => setL('migrationBlock', v ?? 10)} min={1} />
              </Field>
            </div>
            <Field label="Cleanup lines" htmlFor="ps-cleanup" hint="One per line, returned when a package is integrated.">
              <textarea id="ps-cleanup" rows={3} value={legacy.cleanup.join('\n')} onChange={(e) => setL('cleanup', e.target.value.split('\n'))} className={`${mono} py-2 text-sm`} spellCheck={false} data-testid="ps-cleanup" />
            </Field>
          </Group>
        )}
      </div>

      <div className="space-y-2">
        {badNumbers && <div className="text-waiting">Parallel packages and gate rounds are whole numbers, at least 1.</div>}
        <SaveButton testId="ps-save" pending={save.isPending} error={save.error as Error | null} disabled={!name.trim() || badNumbers || (!hasPackages && !!prefixProblem)} onSave={() => save.mutate()} />
      </div>

      <CheckSetup p={p} />

      {!hasPackages && (
        <Group title="Delete" hint="Only while the project has no packages; one with history is archived instead." testId="setup-delete">
          {confirmDelete ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate()} data-testid="ps-delete-confirm">Delete {p.name}</Button>
              <Button onClick={() => setConfirmDelete(false)}>Keep</Button>
            </div>
          ) : (
            <div>
              <Button onClick={() => setConfirmDelete(true)} data-testid="ps-delete">Delete project…</Button>
            </div>
          )}
          {del.error && <div role="alert" className="text-error">{(del.error as Error).message}</div>}
        </Group>
      )}
    </div>
  );
}

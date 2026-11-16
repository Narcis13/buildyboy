// "New project" and "Put on the factory": creates a factory project (POST /api/factory/projects). Opens prefilled from
// its URL (/projects/new?key=&name=&repo=&machineId=&checkout=&lineFile=&idPrefix=), which is how the repositories
// list and the factory-init skill hand it the fields.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ID_PREFIX_RE, PROJECT_KEY_RE, type ProjectView } from '../../../../shared/factory.ts';
import type { MachineSummary } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { navigate } from '../../lib/router.tsx';
import { Button, Card } from '../ui.tsx';
import { Field, inputClass } from '../settings/bits.tsx';
import { keyFrom } from '../factory/projects.tsx';

export interface ProjectPrefill {
  key?: string;
  name?: string;
  repo?: string;
  machineId?: string;
  checkout?: string;
  lineFile?: string;
  idPrefix?: string;
}

/** The query parameters of /projects/new. */
export function prefillFromSearch(search: string): ProjectPrefill {
  const q = new URLSearchParams(search);
  const out: ProjectPrefill = {};
  for (const k of ['key', 'name', 'repo', 'machineId', 'checkout', 'lineFile', 'idPrefix'] as const) {
    const v = q.get(k);
    if (v) out[k] = v;
  }
  return out;
}

/** /projects/new?… for these fields. */
export function newProjectHref(p: ProjectPrefill): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
  const s = q.toString();
  return `/projects/new${s ? `?${s}` : ''}`;
}

/** The fields shared by the new-project form and the Setup tab: where the line runs. */
export function MachineSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const machines = useQuery({ queryKey: ['machines'], queryFn: () => api.get<MachineSummary[]>('/api/machines') });
  const list = machines.data ?? [];
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} data-testid={id}>
      <option value="">None yet</option>
      {value && !list.some((m) => m.id === value) && <option value={value}>{machines.isLoading ? value : `${value} (unknown)`}</option>}
      {list
        .filter((m) => !m.revoked || m.id === value)
        .map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.runnerOnline ? '' : ' (runner offline)'}
          </option>
        ))}
    </select>
  );
}

export function NewProjectForm({ prefill }: { prefill: ProjectPrefill }) {
  const qc = useQueryClient();
  const [name, setName] = useState(prefill.name ?? '');
  const [key, setKey] = useState(prefill.key ?? (prefill.repo || prefill.name ? keyFrom(prefill.repo || prefill.name || '') : ''));
  const [keyTouched, setKeyTouched] = useState(!!prefill.key);
  const [repo, setRepo] = useState(prefill.repo ?? '');
  const [idPrefix, setIdPrefix] = useState(prefill.idPrefix ?? '');
  const [machineId, setMachineId] = useState(prefill.machineId ?? '');
  const [checkout, setCheckout] = useState(prefill.checkout ?? '');
  const [lineFile, setLineFile] = useState(prefill.lineFile ?? 'factory.json');

  const create = useMutation({
    mutationFn: () =>
      api.post<ProjectView>('/api/factory/projects', {
        key: key.trim(),
        name: name.trim() || key.trim(),
        repo: repo.trim() || null,
        idPrefix,
        machineId: machineId || null,
        checkout: checkout.trim() || null,
        lineFile: lineFile.trim() || 'factory.json',
      }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['factory-projects'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      navigate(`/projects/${encodeURIComponent(p.key)}`);
    },
  });

  const keyProblem = !key.trim()
    ? null
    : key.trim() === 'new'
      ? '“new” is taken by this page; pick another key.'
      : PROJECT_KEY_RE.test(key.trim())
        ? null
        : 'A lower-case letter, then letters, digits and “-”, 2 to 24 characters.';
  const prefixProblem = ID_PREFIX_RE.test(idPrefix) ? null : 'Empty, or upper-case letters and digits ending in “-”, e.g. ED-.';
  const repoProblem = !repo.trim() || /^[\w.-]+(?:\/[\w.-]+)*$/.test(repo.trim()) ? null : 'owner/name, e.g. narcis13/shop-api.';
  const ok = !!key.trim() && !keyProblem && !prefixProblem && !repoProblem;

  return (
    <Card className="p-4" data-testid="new-project">
      <form
        className="grid gap-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) create.mutate();
        }}
      >
        <Field label="Name" htmlFor="np-name">
          <input
            id="np-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!keyTouched) setKey(keyFrom(e.target.value));
            }}
            className={inputClass}
            placeholder="Shop API"
            maxLength={120}
            data-testid="np-name"
          />
        </Field>
        <Field label="Key" htmlFor="np-key" hint={keyProblem ?? 'Never changes. Used in URLs, the CLI and the agents’ tools.'}>
          <input
            id="np-key"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setKeyTouched(true);
            }}
            className={`${inputClass} font-mono ${keyProblem ? 'border-waiting' : ''}`}
            placeholder="shop-api"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
            data-testid="np-key"
          />
        </Field>
        <Field label="Repository" htmlFor="np-repo" hint={repoProblem ?? 'GitHub owner/name. Packages created with this repo land in the project; its checkouts show under Activity.'}>
          <input id="np-repo" value={repo} onChange={(e) => setRepo(e.target.value)} className={`${inputClass} font-mono`} placeholder="owner/name" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="np-repo" />
        </Field>
        <Field label="Id prefix (optional)" htmlFor="np-prefix" hint={prefixProblem ?? 'Package ids of this project start with it (P1 → ED-P1). Fixed once it has packages.'}>
          <input
            id="np-prefix"
            value={idPrefix}
            onChange={(e) => setIdPrefix(e.target.value.toUpperCase())}
            className={`${inputClass} font-mono ${prefixProblem ? 'border-waiting' : ''}`}
            placeholder="ED-"
            maxLength={9}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            data-testid="np-prefix"
          />
        </Field>
        <Field label="Machine" htmlFor="np-machine" hint="Its runner runs the project's line.">
          <MachineSelect id="np-machine" value={machineId} onChange={setMachineId} />
        </Field>
        <Field label="Main checkout" htmlFor="np-checkout" hint="The trusted checkout on that machine; the line file is read from here, never from a worktree.">
          <input id="np-checkout" value={checkout} onChange={(e) => setCheckout(e.target.value)} className={`${inputClass} font-mono`} placeholder="C:\work\shop-api" spellCheck={false} data-testid="np-checkout" />
        </Field>
        <Field label="Line file" htmlFor="np-line" hint="Relative to the checkout.">
          <input id="np-line" value={lineFile} onChange={(e) => setLineFile(e.target.value)} className={`${inputClass} font-mono`} placeholder="factory.json" spellCheck={false} data-testid="np-line" />
        </Field>
        <div className="flex flex-wrap items-center gap-3 md:col-span-2">
          <Button type="submit" variant="primary" disabled={!ok || create.isPending} data-testid="np-submit">
            {create.isPending ? 'Creating…' : 'Create project'}
          </Button>
          <Button type="button" onClick={() => navigate('/projects')}>Cancel</Button>
          {create.error && <span className="text-error" role="alert" data-testid="np-error">{(create.error as Error).message}</span>}
        </div>
      </form>
    </Card>
  );
}

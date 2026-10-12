import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { checkOptions, EFFORTS, PERMISSION_MODES } from '../../../../runner/options.ts';
import { api, ApiError } from '../../lib/api.ts';
import { navigate } from '../../lib/router.tsx';
import { Button, Card, PageTitle, Toggle } from '../ui.tsx';
import { fetchMachines, Field, inputCls } from './common.tsx';

interface PromptItem {
  id: number | string;
  title: string;
}

/** GET /api/prompts belongs to the prompt factory; accept an array or {prompts: [...]}, and treat errors as "none yet". */
async function fetchPrompts(): Promise<PromptItem[]> {
  try {
    const r = await api.get<unknown>('/api/prompts');
    const list = Array.isArray(r) ? r : Array.isArray((r as { prompts?: unknown })?.prompts) ? (r as { prompts: unknown[] }).prompts : [];
    return list
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && (typeof (p as { id?: unknown }).id === 'number' || typeof (p as { id?: unknown }).id === 'string'))
      .map((p) => ({ id: p.id as number | string, title: typeof p.title === 'string' && p.title ? p.title : `Prompt ${p.id}` }));
  } catch {
    return [];
  }
}

interface Projects {
  runnerOnline: boolean;
  allowedRoots: string[];
  projects: { id: number; name: string; path: string }[];
  recent: string[];
}

const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const OTHER = '__other__';
const lines = (s: string) => s.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);

export function LaunchForm({ promptId: initialPrompt, schedule = false }: { promptId?: string | null; schedule?: boolean }) {
  const qc = useQueryClient();
  const prompts = useQuery({ queryKey: ['jobs', 'prompts'], queryFn: fetchPrompts, retry: false });
  const machines = useQuery({ queryKey: ['jobs', 'machines'], queryFn: fetchMachines });

  const [mode, setMode] = useState<'run' | 'schedule'>(schedule ? 'schedule' : 'run');
  const [cron, setCron] = useState('0 2 * * *');
  const [promptId, setPromptId] = useState(initialPrompt ?? '');
  const [promptText, setPromptText] = useState('');
  const [machineId, setMachineId] = useState('');
  const [dir, setDir] = useState('');
  const [customDir, setCustomDir] = useState('');
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('');
  const [fallbackModel, setFallbackModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permissionMode, setPermissionMode] = useState('');
  const [budget, setBudget] = useState('5');
  const [maxTurns, setMaxTurns] = useState('');
  const [allowed, setAllowed] = useState('');
  const [disallowed, setDisallowed] = useState('');
  const [worktree, setWorktree] = useState(false);
  const [walkMode, setWalkMode] = useState(false);
  const [limit, setLimit] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // default machine: the first with a runner online
  useEffect(() => {
    if (!machineId && machines.data?.length) setMachineId((machines.data.find((m) => m.runnerOnline && !m.revoked) ?? machines.data[0]).id);
  }, [machines.data, machineId]);

  const projects = useQuery({
    queryKey: ['jobs', 'projects', machineId],
    queryFn: () => api.get<Projects>(`/api/runner/projects?machine=${encodeURIComponent(machineId)}`),
    enabled: !!machineId,
  });
  const dirs = useMemo(() => {
    const p = projects.data;
    if (!p) return [] as { path: string; label: string }[];
    const seen = new Set<string>();
    const out: { path: string; label: string }[] = [];
    const add = (path: string, label: string) => {
      if (!seen.has(path)) {
        seen.add(path);
        out.push({ path, label });
      }
    };
    p.projects.forEach((x) => add(x.path, `${x.name} — ${x.path}`));
    p.recent.forEach((x) => add(x, `${x} (recent)`));
    p.allowedRoots.forEach((x) => add(x, `${x} (allowed root)`));
    return out;
  }, [projects.data]);
  useEffect(() => {
    if (dirs.length && (!dir || (dir !== OTHER && !dirs.some((d) => d.path === dir)))) setDir(dirs[0].path);
    if (!dirs.length && projects.data) setDir(OTHER);
  }, [dirs, dir, projects.data]);

  const cwd = dir === OTHER || !dir ? customDir.trim() : dir;
  const options = useMemo(() => {
    const o: Record<string, unknown> = { maxBudgetUsd: budget === '' ? undefined : Number(budget) };
    if (model.trim()) o.model = model.trim();
    if (fallbackModel.trim()) o.fallbackModel = fallbackModel.trim();
    if (effort) o.effort = effort;
    if (permissionMode) o.permissionMode = permissionMode;
    if (maxTurns !== '') o.maxTurns = Number(maxTurns);
    if (allowed.trim()) o.allowedTools = lines(allowed);
    if (disallowed.trim()) o.disallowedTools = lines(disallowed);
    if (worktree) o.worktree = true;
    o.walkMode = walkMode;
    if (limit !== '') o.limitMinutes = Number(limit);
    return o;
  }, [budget, model, fallbackModel, effort, permissionMode, maxTurns, allowed, disallowed, worktree, walkMode, limit]);
  const optionError = useMemo(() => {
    try {
      checkOptions(options);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, [options]);

  const machine = machines.data?.find((m) => m.id === machineId);
  const missing = !promptId && !promptText.trim() ? 'Pick a saved prompt or paste one' : !machineId ? 'Pick a machine' : !cwd ? 'Pick a project directory' : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (missing || optionError) return setError(missing ?? optionError);
    const job = { promptId: promptId || null, promptText: promptId ? null : promptText, machineId, cwd, title: title.trim() || null, options };
    setBusy(true);
    try {
      if (mode === 'schedule') {
        await api.post('/api/schedules', { cron: cron.trim(), job });
        await qc.invalidateQueries({ queryKey: ['jobs'] });
        navigate('/jobs#schedules');
      } else {
        const r = await api.post<{ id: string }>('/api/jobs', job);
        await qc.invalidateQueries({ queryKey: ['jobs'] });
        navigate(`/jobs/${r.id}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Launch failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle right={<Button onClick={() => navigate('/jobs')}>Cancel</Button>}>{mode === 'schedule' ? 'New schedule' : 'Launch a job'}</PageTitle>
      <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Launch form">
        <Card className="flex flex-col gap-3 p-4">
          <Field label="Saved prompt">
            <select aria-label="Saved prompt" className={inputCls} value={promptId} onChange={(e) => setPromptId(e.target.value)}>
              <option value="">— Paste a prompt instead —</option>
              {promptId && !prompts.data?.some((p) => String(p.id) === promptId) && <option value={promptId}>Prompt #{promptId}</option>}
              {prompts.data?.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
          {!promptId && (
            <Field label="Prompt text" hint={prompts.data && !prompts.data.length ? 'No saved prompts yet — write one in the Composer, or paste it here.' : undefined}>
              <textarea aria-label="Prompt text" className={`${inputCls} min-h-32 py-2 font-mono text-sm`} value={promptText} onChange={(e) => setPromptText(e.target.value)} placeholder="Goal: …" />
            </Field>
          )}
          <Field label="Title (optional)">
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Defaults to the prompt title" />
          </Field>
        </Card>

        <Card className="flex flex-col gap-3 p-4">
          <Field label="Machine" hint={machine && !machine.runnerOnline ? 'This machine’s runner is offline; the job will wait in the queue.' : undefined}>
            <select aria-label="Machine" className={inputCls} value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              {!machines.data?.length && <option value="">No machines paired yet</option>}
              {machines.data?.map((m) => (
                <option key={m.id} value={m.id} disabled={m.revoked}>
                  {m.name} {m.runnerOnline ? '· runner online' : '· runner offline'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Project directory" hint={projects.data?.allowedRoots.length ? `Must be inside: ${projects.data.allowedRoots.join(', ')}` : 'The runner only accepts directories inside its allowed roots.'}>
            {dirs.length > 0 && (
              <select aria-label="Project directory" className={inputCls} value={dir} onChange={(e) => setDir(e.target.value)}>
                {dirs.map((d) => (
                  <option key={d.path} value={d.path}>
                    {d.label}
                  </option>
                ))}
                <option value={OTHER}>Other path…</option>
              </select>
            )}
          </Field>
          {(dir === OTHER || !dirs.length) && (
            <Field label="Directory path">
              <input aria-label="Directory path" className={`${inputCls} font-mono text-sm`} value={customDir} onChange={(e) => setCustomDir(e.target.value)} placeholder={projects.data?.allowedRoots[0] ?? 'C:\\code\\my-repo'} />
            </Field>
          )}
          <div className="flex flex-wrap gap-x-6">
            <Toggle on={worktree} onChange={setWorktree} label="New git worktree (-w)" />
            <Toggle on={walkMode} onChange={setWalkMode} label="Walk mode" />
          </div>
        </Card>

        <Card className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
          <Field label="Max budget USD (required)">
            <input aria-label="Max budget USD" className={inputCls} type="number" inputMode="decimal" min="0.01" step="0.01" required value={budget} onChange={(e) => setBudget(e.target.value)} />
          </Field>
          <Field label="Limit (minutes)">
            <input aria-label="Limit minutes" className={inputCls} type="number" inputMode="numeric" min="1" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="No limit" />
          </Field>
          <Field label="Model">
            <input aria-label="Model" className={inputCls} list="bb-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Default" />
          </Field>
          <Field label="Fallback model">
            <input aria-label="Fallback model" className={inputCls} list="bb-models" value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)} placeholder="None" />
          </Field>
          <datalist id="bb-models">
            {MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <Field label="Effort">
            <select aria-label="Effort" className={inputCls} value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="">Default</option>
              {EFFORTS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
          <Field label="Permission mode">
            <select aria-label="Permission mode" className={inputCls} value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
              <option value="">Default</option>
              {PERMISSION_MODES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
          <Field label="Max turns">
            <input aria-label="Max turns" className={inputCls} type="number" inputMode="numeric" min="1" step="1" value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} placeholder="No limit" />
          </Field>
          <div className="hidden sm:block" />
          <Field label="Extra allowed tools" hint="One per line, e.g. Bash(npm test:*)">
            <textarea aria-label="Extra allowed tools" className={`${inputCls} min-h-20 py-2 font-mono text-sm`} value={allowed} onChange={(e) => setAllowed(e.target.value)} />
          </Field>
          <Field label="Disallowed tools" hint="One per line">
            <textarea aria-label="Disallowed tools" className={`${inputCls} min-h-20 py-2 font-mono text-sm`} value={disallowed} onChange={(e) => setDisallowed(e.target.value)} />
          </Field>
        </Card>

        <Card className="flex flex-col gap-3 p-4">
          <div role="radiogroup" aria-label="When" className="flex gap-2">
            {(['run', 'schedule'] as const).map((m) => (
              <Button key={m} type="button" role="radio" aria-checked={mode === m} variant={mode === m ? 'primary' : 'ghost'} onClick={() => setMode(m)}>
                {m === 'run' ? 'Run now' : 'On a schedule'}
              </Button>
            ))}
          </div>
          {mode === 'schedule' && (
            <Field label="Cron (minute hour day month weekday, server time)" hint="e.g. 0 2 * * * = every night at 02:00">
              <input aria-label="Cron" className={`${inputCls} font-mono`} value={cron} onChange={(e) => setCron(e.target.value)} />
            </Field>
          )}
          {(error || optionError) && (
            <p role="alert" className="text-[15px] text-error">
              {error ?? optionError}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" disabled={busy || !!optionError}>
            {mode === 'schedule' ? 'Create schedule' : 'Launch job'}
          </Button>
        </Card>
      </form>
    </div>
  );
}

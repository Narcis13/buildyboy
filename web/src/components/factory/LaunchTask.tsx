// "Launch" for a backlog package: pick a machine and a directory, start it as an interactive agent in a herdr
// terminal (hc, the default) or as a headless `claude -p` job. POST /api/tasks/:id/launch creates the job; the
// runner on that machine does the work inside its allowed roots.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskSummary } from '../../../../shared/factory.ts';
import { api, ApiError } from '../../lib/api.ts';
import { Link } from '../../lib/router.tsx';
import { Button, Card } from '../ui.tsx';
import { fetchMachines, Field, inputCls } from '../jobs/common.tsx';

interface Projects {
  runnerOnline: boolean;
  allowedRoots: string[];
  projects: { id: number; name: string; path: string }[];
  recent: string[];
}

type Launcher = 'hc' | 'claude';
const LAUNCHERS: { id: Launcher; label: string; hint: string }[] = [
  { id: 'hc', label: 'hc terminal', hint: 'Interactive claude in a herdr terminal you can attach to' },
  { id: 'claude', label: 'claude -p', hint: 'Headless job with a transcript on the Jobs page' },
];
const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];

/** A repo field that is an absolute path (Windows, POSIX or ~) can prefill the directory; a name or URL cannot. */
const looksLikePath = (s: string | null | undefined): boolean => !!s && /^([a-zA-Z]:[\\/]|\/(?!\/)|~[\\/])/.test(s.trim());

export function LaunchTask({ task }: { task: TaskSummary }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [machineId, setMachineId] = useState('');
  const [cwd, setCwd] = useState(task.repo && looksLikePath(task.repo) ? task.repo.trim() : '');
  const [launcher, setLauncher] = useState<Launcher>('hc');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ id: string; launcher: Launcher } | null>(null);

  const machines = useQuery({ queryKey: ['jobs', 'machines'], queryFn: fetchMachines, enabled: open });
  const usable = useMemo(() => (machines.data ?? []).filter((m) => !m.revoked), [machines.data]);
  useEffect(() => {
    if (!machineId && usable.length) setMachineId((usable.find((m) => m.runnerOnline) ?? usable[0]).id);
  }, [usable, machineId]);
  const machine = usable.find((m) => m.id === machineId);

  const projects = useQuery({
    queryKey: ['jobs', 'projects', machineId],
    queryFn: () => api.get<Projects>(`/api/runner/projects?machine=${encodeURIComponent(machineId)}`),
    enabled: open && !!machineId,
  });
  const dirs = useMemo(() => {
    const p = projects.data;
    const out = new Set<string>();
    p?.projects.forEach((x) => out.add(x.path));
    p?.recent.forEach((x) => out.add(x));
    p?.allowedRoots.forEach((x) => out.add(x));
    return [...out];
  }, [projects.data]);
  // no path in the package: offer the project whose name or directory ends with its repo field
  useEffect(() => {
    if (cwd || !task.repo || looksLikePath(task.repo)) return;
    const want = task.repo.trim().replace(/\.git$/, '').split(/[\\/]/).pop()?.toLowerCase();
    const hit = projects.data?.projects.find((x) => x.name.toLowerCase() === want || x.path.toLowerCase().split(/[\\/]/).pop() === want);
    if (hit) setCwd(hit.path);
  }, [projects.data, cwd, task.repo]);

  const done = task.status === 'integrata';
  const problem = !machineId ? 'Pick a machine' : !cwd.trim() ? 'Enter the working directory' : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const r = await api.post<{ id: string; launcher: Launcher }>(`/api/tasks/${encodeURIComponent(task.id)}/launch`, {
        machineId,
        cwd: cwd.trim(),
        launcher,
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      setStarted({ id: r.id, launcher });
      for (const key of ['tasks', 'task', 'jobs', 'sessions']) void qc.invalidateQueries({ queryKey: [key] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Launch failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="launch-task" className="flex flex-col gap-2">
      <div>
        <Button variant="primary" onClick={() => setOpen(!open)} aria-expanded={open} disabled={done} title={done ? 'This package is already integrated' : undefined}>
          {open ? 'Close launch' : 'Launch'}
        </Button>
      </div>
      {open && (
        <Card className="p-3 sm:p-4">
          <form onSubmit={submit} className="flex flex-col gap-3" aria-label={`Launch ${task.id}`}>
            <Field
              label="Machine"
              hint={machine ? (machine.runnerOnline ? <span className="text-working">Runner online</span> : <span className="text-waiting">Runner offline: the job waits until it connects</span>) : undefined}
            >
              <select className={inputCls} value={machineId} onChange={(e) => setMachineId(e.target.value)} aria-label="Machine">
                {!usable.length && <option value="">{machines.isLoading ? 'Loading…' : 'No machines paired'}</option>}
                {usable.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · runner {m.runnerOnline ? 'online' : 'offline'}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Working directory" hint={projects.data?.allowedRoots.length ? `Inside ${projects.data.allowedRoots.join(', ')}` : undefined}>
              <input className={`${inputCls} font-mono`} value={cwd} onChange={(e) => setCwd(e.target.value)} list={`launch-dirs-${task.id}`} placeholder="/path/to/repo" autoComplete="off" spellCheck={false} aria-label="Working directory" />
              <datalist id={`launch-dirs-${task.id}`}>
                {dirs.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
            </Field>

            <div role="group" aria-label="Launcher" className="flex flex-col gap-1 text-sm text-muted">
              <span>Launcher</span>
              <div className="grid grid-cols-2 gap-2">
                {LAUNCHERS.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    aria-pressed={launcher === l.id}
                    onClick={() => setLauncher(l.id)}
                    className={`min-h-11 rounded-lg border px-3 text-[15px] ${launcher === l.id ? 'border-accent bg-panel-2 text-ink shadow-[inset_0_-2px_0_var(--bb-accent)]' : 'border-line bg-bg-2 text-muted hover:text-ink'}`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
              <span>{LAUNCHERS.find((l) => l.id === launcher)!.hint}</span>
            </div>

            <Field label="Model (optional)">
              <input className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} list="launch-models" placeholder="default" autoComplete="off" spellCheck={false} aria-label="Model" />
              <datalist id="launch-models">
                {MODELS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>

            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
            {started && (
              <p role="status" className="text-sm">
                {started.launcher === 'hc' ? 'Starting in a herdr terminal. ' : 'Job started. '}
                <Link to={`/jobs/${started.id}`} className="inline-flex min-h-11 items-center text-accent underline">
                  Open job {started.id.slice(0, 8)}
                </Link>
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={busy || !!problem}>
                {busy ? 'Launching…' : started ? 'Launch again' : 'Launch'}
              </Button>
              <Button type="button" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}

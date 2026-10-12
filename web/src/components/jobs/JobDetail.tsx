import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { StoredJobOptions } from '../../../../runner/options.ts';
import { api, ApiError } from '../../lib/api.ts';
import { duration, exactTime, usd } from '../../lib/format.ts';
import { Link, navigate } from '../../lib/router.tsx';
import { Button, Card, PageTitle, RelTime } from '../ui.tsx';
import { Countdown, inputCls, isLive, JobBadge, jobDeadline, jobDuration, type JobDetailView } from './common.tsx';
import { OutputView, type OutputLine } from './OutputView.tsx';

/** Output is fetched incrementally (`?after=<seq>`) and accumulated, so live updates only move new lines. */
function useJobOutput(id: string) {
  const acc = useRef<{ id: string; lines: OutputLine[] }>({ id, lines: [] });
  if (acc.current.id !== id) acc.current = { id, lines: [] };
  return useQuery({
    queryKey: ['jobs', id, 'output'],
    queryFn: async () => {
      const a = acc.current;
      for (let i = 0; i < 25; i++) {
        const after = a.lines.length ? a.lines[a.lines.length - 1].seq : -1;
        const r = await api.get<{ lines: OutputLine[]; total: number }>(`/api/jobs/${encodeURIComponent(id)}/output?after=${after}&limit=2000`);
        // overlapping fetches (live invalidations) may return the same lines: keep seq strictly increasing
        const last = a.lines.length ? a.lines[a.lines.length - 1].seq : -1;
        a.lines = a.lines.concat(r.lines.filter((l) => l.seq > last));
        if (r.lines.length < 2000) break;
      }
      return a.lines.slice();
    },
  });
}

function ConfirmButton({ label, confirmLabel, onConfirm, variant = 'ghost', disabled }: { label: string; confirmLabel: string; onConfirm: () => void; variant?: 'ghost' | 'danger' | 'primary'; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      variant={armed ? 'danger' : variant}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

function Verify({ j, run }: { j: JobDetailView; run: (path: string, body?: unknown) => Promise<unknown> }) {
  const [text, setText] = useState(j.verifyCommands.join('\n'));
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState<number | null>(null);
  const commands = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const canRun = !isLive(j.status) && j.status !== 'queued';
  const waiting = sent !== null && (!j.verify || j.verify.ranAt < sent);
  return (
    <Card className="flex flex-col gap-3 p-4" aria-label="Verify">
      <div>
        <h2 className="text-base font-semibold">Verify</h2>
        <p className="text-sm text-muted">Runs the Done-when commands on {j.machineName ?? 'the runner'} in the job’s directory, to check the agent’s claims.</p>
      </div>
      <label className="flex flex-col gap-1 text-sm text-muted">
        Commands (one per line)
        <textarea aria-label="Verify commands" className={`${inputCls} min-h-20 py-2 font-mono text-sm`} value={text} onChange={(e) => { setText(e.target.value); setConfirming(false); }} placeholder="npm test" />
      </label>
      {!confirming ? (
        <Button onClick={() => setConfirming(true)} disabled={!commands.length || !canRun || !j.runnerOnline}>
          {!canRun ? 'Verify (after the job ends)' : !j.runnerOnline ? 'Verify (runner offline)' : `Verify ${commands.length} command${commands.length === 1 ? '' : 's'}…`}
        </Button>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-waiting/60 p-3">
          <p className="text-[15px]">
            Run these {commands.length} command{commands.length === 1 ? '' : 's'} with the shell in <span className="break-all font-mono text-sm">{j.cwd}</span>?
          </p>
          <ul className="list-disc pl-5 font-mono text-sm">
            {commands.map((c) => (
              <li key={c} className="break-all">
                {c}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="warn"
              onClick={async () => {
                setConfirming(false);
                setSent(Date.now());
                try {
                  await run('verify', { commands, confirmed: true });
                } catch {
                  setSent(null);
                }
              }}
            >
              Confirm and run
            </Button>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {waiting && <p className="text-sm text-muted">Running on the runner…</p>}
      {j.verify && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">
            Last run <RelTime ts={j.verify.ranAt} />: {j.verify.results.filter((r) => r.ok).length}/{j.verify.results.length} passed
          </p>
          {j.verify.results.map((r, i) => (
            <details key={i} className={`rounded-lg border px-3 py-1 ${r.ok ? 'border-working/50' : 'border-error/60'}`}>
              <summary className="flex min-h-11 cursor-pointer items-center gap-2">
                <span className={`font-semibold ${r.ok ? 'text-working' : 'text-error'}`}>{r.ok ? 'PASS' : 'FAIL'}</span>
                <span className="break-all font-mono text-sm">{r.command}</span>
                {r.exitCode !== null && !r.ok && <span className="text-sm text-muted">exit {r.exitCode}</span>}
              </summary>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words pb-2 font-mono text-xs text-muted">{r.output || '(no output)'}</pre>
            </details>
          ))}
        </div>
      )}
    </Card>
  );
}

export function JobDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data: j, error, isLoading } = useQuery({ queryKey: ['jobs', id], queryFn: () => api.get<JobDetailView>(`/api/jobs/${encodeURIComponent(id)}`), retry: false });
  const output = useJobOutput(id);
  const [msg, setMsg] = useState('');
  const [resumeText, setResumeText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (path: string, body: unknown = {}) => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post<{ id?: string }>(`/api/jobs/${encodeURIComponent(id)}/${path}`, body);
      await qc.invalidateQueries({ queryKey: ['jobs'] });
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Request failed');
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const spawn = async (path: 'resume' | 'rerun', body?: unknown) => {
    const r = await run(path, body).catch(() => null);
    if (r?.id) navigate(`/jobs/${r.id}`);
  };

  if (isLoading) return <div className="p-4 text-muted">Loading…</div>;
  if (error || !j) return <div className="p-4 text-muted">Job not found. <Link to="/jobs" className="text-accent underline">All jobs</Link></div>;

  const live = isLive(j.status);
  const deadline = live ? jobDeadline(j) : null;
  const o = j.options as StoredJobOptions;
  const reason = typeof j.result?.reason === 'string' ? j.result.reason : null;
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!msg.trim()) return;
    await run('message', { text: msg.trim() }).then(() => setMsg('')).catch(() => {});
  };
  const opts = [
    o.model && `model ${o.model}`, o.fallbackModel && `fallback ${o.fallbackModel}`, o.effort && `effort ${o.effort}`, o.permissionMode && `${o.permissionMode} mode`,
    `budget ${usd(o.maxBudgetUsd)}`, o.maxTurns && `${o.maxTurns} turns max`, o.worktree && 'worktree', o.walkMode && 'walk mode', o.limitMinutes && `${o.limitMinutes} min limit`,
    o.resumeSessionId && `resumes ${o.resumeSessionId.slice(0, 8)}`, o.allowedTools?.length && `allow ${o.allowedTools.join(', ')}`, o.disallowedTools?.length && `deny ${o.disallowedTools.join(', ')}`,
  ].filter(Boolean);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div>
        <Link to="/jobs" className="inline-flex min-h-11 items-center text-[15px] text-accent">← Jobs</Link>
        <PageTitle right={<JobBadge status={j.status} />}>
          <span className="break-words">{j.title ?? `Job ${j.id.slice(0, 8)}`}</span>
        </PageTitle>
      </div>

      <Card className="grid grid-cols-2 gap-x-4 gap-y-2 p-4 text-[15px] sm:grid-cols-4">
        <div><div className="text-xs text-muted">Machine</div>{j.machineName ?? j.machineId.slice(0, 8)}{!j.runnerOnline && <span className="text-sm text-muted"> (offline)</span>}</div>
        <div><div className="text-xs text-muted">Cost</div><span className="tabular-nums">{usd(j.costUsd)}</span> <span className="text-sm text-muted">/ {usd(o.maxBudgetUsd)}</span></div>
        <div><div className="text-xs text-muted">Duration</div><span className="tabular-nums">{duration(jobDuration(j))}</span>{deadline && <div className="text-sm"><Countdown until={deadline} /></div>}</div>
        <div><div className="text-xs text-muted">Created</div><RelTime ts={j.createdAt} /></div>
        <div className="col-span-2 sm:col-span-4"><div className="text-xs text-muted">Directory</div><span className="break-all font-mono text-sm">{j.cwd}</span></div>
        {j.sessionId && <div className="col-span-2"><div className="text-xs text-muted">Session</div><Link to={`/s/${j.sessionId}`} className="inline-flex min-h-11 items-center font-mono text-sm text-accent underline">{j.sessionId.slice(0, 8)} → session page</Link></div>}
        {j.rerunOf && <div className="col-span-2"><div className="text-xs text-muted">From job</div><Link to={`/jobs/${j.rerunOf}`} className="inline-flex min-h-11 items-center font-mono text-sm text-accent underline">{j.rerunOf.slice(0, 8)}</Link></div>}
        {opts.length > 0 && <div className="col-span-2 text-sm text-muted sm:col-span-4">{opts.join(' · ')}</div>}
        {(reason || j.exitCode !== null) && j.status !== 'succeeded' && (
          <div className="col-span-2 text-sm text-error sm:col-span-4" title={exactTime(j.endedAt)}>
            {reason}{j.exitCode !== null ? ` (exit ${j.exitCode})` : ''}
          </div>
        )}
        {j.status === 'queued' && <div className="col-span-2 text-sm text-muted sm:col-span-4">{j.runnerOnline ? 'Waiting for a free slot on the runner…' : 'Waiting for the runner on this machine to come online…'}</div>}
      </Card>

      <div className="flex flex-wrap gap-2">
        {(live || j.status === 'queued') && <ConfirmButton label={j.status === 'queued' ? 'Cancel' : 'Stop'} confirmLabel="Tap again to stop" onConfirm={() => void run('stop').catch(() => {})} disabled={busy} />}
        {!live && j.status !== 'queued' && (
          <>
            <Button onClick={() => void spawn('rerun')} disabled={busy}>Rerun</Button>
            {j.sessionId && <Button onClick={() => void spawn('resume', { text: resumeText.trim() || undefined })} disabled={busy}>Resume</Button>}
          </>
        )}
      </div>
      {!live && j.status !== 'queued' && j.sessionId && (
        <input aria-label="Resume message" className={inputCls} value={resumeText} onChange={(e) => setResumeText(e.target.value)} placeholder="Message to resume with (optional): Continue where you left off." />
      )}
      {err && <p role="alert" className="text-[15px] text-error">{err}</p>}

      {live && (
        <form onSubmit={send} className="flex gap-2" aria-label="Follow-up message">
          <input aria-label="Follow-up message" className={inputCls} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Send a follow-up message…" />
          <Button type="submit" variant="primary" disabled={busy || !msg.trim()}>Send</Button>
        </form>
      )}

      <Card className="p-4">
        <OutputView lines={output.data ?? []} live={live} />
      </Card>

      <Verify j={j} run={run} />

      <details className="rounded-xl border border-line bg-panel p-4">
        <summary className="min-h-11 cursor-pointer text-base font-semibold">Prompt</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-sm">{j.promptText}</pre>
      </details>
    </div>
  );
}

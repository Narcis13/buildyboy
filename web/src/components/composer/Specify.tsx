// Spec-ify: send a rough idea through a runner job (Opus, structured output) and fill Goal / Done when / Scope and a
// draft spec. Nothing is saved until you review and save the prompt yourself.
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { JobView, MachineSummary } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { Link } from '../../lib/router.tsx';
import { Button } from '../ui.tsx';
import { inputCls, labelCls } from './fields.tsx';

export interface SpecifyResult {
  goal: string;
  doneWhen: string[];
  scope: string;
  spec: string;
}

export function Specify({ onResult }: { onResult: (r: SpecifyResult) => void }) {
  const [idea, setIdea] = useState('');
  const [machineId, setMachineId] = useState('');
  const [cwd, setCwd] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const machines = useQuery({ queryKey: ['machines'], queryFn: () => api.get<MachineSummary[]>('/api/machines') });
  const projects = useQuery({
    queryKey: ['jobs', 'projects', machineId],
    queryFn: () => api.get<{ runnerOnline: boolean; projects: { name: string; path: string }[] }>(`/api/runner/projects?machine=${encodeURIComponent(machineId)}`),
    enabled: !!machineId,
  });
  const job = useQuery({
    queryKey: ['jobs', 'specify', jobId],
    queryFn: () => api.get<JobView>(`/api/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && ['succeeded', 'failed', 'stopped', 'lost'].includes(q.state.data.status) ? false : 3000),
  });
  const start = useMutation({
    mutationFn: () => api.post<{ jobId: string }>('/api/prompts/specify', { idea, machineId, cwd }),
    onSuccess: (r) => setJobId(r.jobId),
  });

  useEffect(() => {
    if (!machineId && machines.data?.length) setMachineId((machines.data.find((m) => m.runnerOnline) ?? machines.data[0]).id);
  }, [machines.data, machineId]);
  useEffect(() => {
    if (!cwd && projects.data?.projects.length) setCwd(projects.data.projects[0].path);
  }, [projects.data, cwd]);

  const structured = (job.data?.result as { structured_output?: SpecifyResult } | null)?.structured_output;
  useEffect(() => {
    if (structured) onResult(structured);
    // fill once per job
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, !!structured]);

  const status = job.data?.status;
  return (
    <div className="space-y-3" data-testid="specify">
      <p className="text-[15px] text-muted">Describe the idea roughly. A read-only Opus job on the chosen machine drafts Goal, Done when, Scope and a spec; you review before saving.</p>
      <textarea className={`${inputCls} min-h-24`} aria-label="Rough idea" placeholder="e.g. add CSV export to the reports page, streaming, with a test for 1M rows" value={idea} onChange={(e) => setIdea(e.target.value)} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="sp-machine">Machine</label>
          <select id="sp-machine" className={inputCls} value={machineId} onChange={(e) => { setMachineId(e.target.value); setCwd(''); }}>
            {(machines.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>{m.name}{m.runnerOnline ? '' : ' · runner offline'}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="sp-cwd">Repository</label>
          <input id="sp-cwd" className={inputCls} list="sp-projects" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="a directory under the runner's allowed roots" />
          <datalist id="sp-projects">
            {(projects.data?.projects ?? []).map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
          </datalist>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={idea.trim().length < 3 || !machineId || !cwd || start.isPending || (!!jobId && !status?.match(/succeeded|failed|stopped|lost/))} onClick={() => { setJobId(null); start.mutate(); }}>
          Spec-ify
        </Button>
        {start.isError && <span className="text-[15px] text-error">{(start.error as Error).message}</span>}
        {jobId && (
          <span className="text-[15px] text-muted">
            <Link to={`/jobs/${jobId}`} className="text-accent underline">job</Link> {status ?? 'queued'}
            {status === 'queued' && projects.data && !projects.data.runnerOnline ? ' (waiting for the runner)' : ''}
            {status === 'succeeded' && (structured ? ' · filled in below, review it' : ' · no structured output')}
          </span>
        )}
      </div>
    </div>
  );
}

// bb runner — job runner daemon. Holds an outbound SSE connection to the server (works behind NAT), runs
// `claude -p` jobs inside the allowed roots from ~/.buildyboy/runner.json, and reports back over HTTP.
//
// Queue design: the server owns the queue. It dispatches only what this runner can take (concurrency and
// one job per repo root), and the runner re-checks both; if it is busy anyway it answers `queued` and the
// server retries on a later dispatch. So no job state lives only on this machine.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import type { JobView, RunnerCommand, RunnerEvent } from '../shared/types.ts';
import { makeApi, readSSE, type Api } from './api.ts';
import { resolveClaude, type Exe } from './claude.ts';
import { loadConfig, type RunnerConfig } from './config.ts';
import { startJob, type RunningJob } from './job.ts';
import { buildClaudeArgs } from './options.ts';
import { checkCwd, pathKey, repoRoot } from './paths.ts';
import { runVerify } from './proc.ts';

export const RUNNER_VERSION = '0.1.0';

export interface Runner {
  stop(): Promise<void>;
  jobs: Map<string, RunningJob>;
}

function runExe(exe: Exe, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((res, rej) => {
    execFile(exe.command, [...exe.prefix, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, shell: false }, (e, stdout) => (e ? rej(e) : res(stdout)));
  });
}

export function startRunner(opts: { configPath?: string; log?: (s: string) => void } = {}): Runner {
  const log = opts.log ?? ((s: string) => console.log(`[runner] ${s}`));
  const cfg: RunnerConfig = loadConfig(opts.configPath);
  const api: Api = makeApi(cfg.url, cfg.token);
  const jobs = new Map<string, RunningJob>();
  /** where finished jobs ran, for Verify (most recent 200) */
  const places = new Map<string, string>();
  const ac = new AbortController();
  const timers: NodeJS.Timeout[] = [];
  let claudeVersion: string | null = null;

  const report = (jobId: string, events: RunnerEvent[]) =>
    api.post(`/api/runner/jobs/${encodeURIComponent(jobId)}/events`, { events }).catch((e) => log(`job ${jobId}: report failed: ${e.message}`));

  const exe = (): Exe => resolveClaude(cfg.claudePath);

  function onJob(job: JobView) {
    if (jobs.has(job.id)) return; // re-sent after a reconnect; it's already running here
    const fail = (reason: string) => {
      log(`job ${job.id}: refused: ${reason}`);
      void report(job.id, [{ type: 'status', status: 'failed', exitCode: null, result: { reason } }]);
    };
    if (places.has(job.id)) return; // already finished here
    const where = checkCwd(job.cwd, cfg.allowedRoots);
    if (!where.ok) return fail(where.reason);
    const sessionId = randomUUID();
    let args: string[];
    let bin: Exe;
    try {
      args = buildClaudeArgs(job.options, { sessionId, title: job.title });
      bin = exe();
    } catch (e) {
      return fail((e as Error).message);
    }
    if (typeof job.promptText !== 'string' || !job.promptText.trim()) return fail('empty prompt');
    const root = repoRoot(where.cwd, where.root);
    const busy = jobs.size >= cfg.concurrency ? `runner busy (${jobs.size}/${cfg.concurrency})` : [...jobs.values()].some((j) => pathKey(j.root) === pathKey(root)) ? `another job is running in ${root}` : null;
    if (busy) {
      log(`job ${job.id}: deferred: ${busy}`);
      void report(job.id, [{ type: 'status', status: 'queued', result: { reason: busy } }]);
      return;
    }
    const j = startJob(job, args, bin, { cwd: where.cwd, root, sessionId }, { cfg, api, log });
    jobs.set(job.id, j);
    void j.done.then(() => {
      jobs.delete(job.id);
      places.set(job.id, j.workDir());
      if (places.size > 200) places.delete(places.keys().next().value!);
      void heartbeat();
    });
  }

  async function onVerify(cmd: { jobId: string; commands: string[]; cwd?: string }) {
    const running = jobs.get(cmd.jobId);
    if (running) return void report(cmd.jobId, [{ type: 'verify', results: [{ command: '(verify)', ok: false, exitCode: null, output: 'job is still running' }] }]);
    const candidates = [places.get(cmd.jobId), cmd.cwd].filter((p): p is string => !!p);
    const where = candidates.map((p) => checkCwd(p, cfg.allowedRoots)).find((w) => w.ok);
    const commands = Array.isArray(cmd.commands) ? cmd.commands.filter((c) => typeof c === 'string' && c.trim()).slice(0, 30) : [];
    if (!where || !where.ok) return void report(cmd.jobId, [{ type: 'verify', results: [{ command: '(verify)', ok: false, exitCode: null, output: 'job directory is not inside the allowed roots' }] }]);
    log(`job ${cmd.jobId}: verify ${commands.length} command(s) in ${where.cwd}`);
    const results = await runVerify(commands, where.cwd);
    await report(cmd.jobId, [{ type: 'verify', results }]);
  }

  function onCommand(c: RunnerCommand & { cwd?: string }) {
    if (c.type === 'job') onJob(c.job);
    else if (c.type === 'stop') jobs.get(c.jobId)?.stop();
    else if (c.type === 'message') {
      if (!jobs.get(c.jobId)?.message(c.text)) log(`job ${c.jobId}: follow-up not delivered (not running here)`);
    } else if (c.type === 'verify') void onVerify(c);
  }

  async function heartbeat() {
    try {
      await api.post('/api/runner/heartbeat', {
        version: RUNNER_VERSION,
        hostname: hostname(),
        platform: process.platform,
        allowedRoots: cfg.allowedRoots,
        concurrency: cfg.concurrency,
        claudeVersion,
        running: [...jobs.values()].map((j) => ({ jobId: j.id, sessionId: j.sessionId(), pid: j.pid() ?? null, startedAt: j.startedAt, cwd: j.cwd })),
      });
    } catch (e) {
      log(`heartbeat failed: ${(e as Error).message}`);
    }
  }

  async function reportAgents() {
    try {
      const out = await runExe(exe(), ['agents', '--json', '--all'], 15_000);
      const agents = JSON.parse(out);
      await api.post('/api/runner/agents', { agents });
    } catch {
      // best effort: older claude, no agents, or server away
    }
  }

  async function connectLoop() {
    let backoff = 1000;
    while (!ac.signal.aborted) {
      let opened = false;
      try {
        await readSSE(api, '/api/runner/stream', (event, data) => {
          if (!opened) {
            opened = true;
            backoff = 1000;
            log(`connected to ${cfg.url}`);
            void heartbeat();
          }
          if (event !== 'command') return;
          try {
            onCommand(JSON.parse(data));
          } catch (e) {
            log(`bad command: ${(e as Error).message}`);
          }
        }, ac.signal);
      } catch (e) {
        if (!ac.signal.aborted) log(`stream error: ${(e as Error).message}`);
      }
      if (ac.signal.aborted) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  void (async () => {
    try {
      claudeVersion = (await runExe(exe(), ['--version'], 15_000)).trim().slice(0, 100) || null;
    } catch {
      claudeVersion = null;
    }
    log(`allowed roots: ${cfg.allowedRoots.join(', ')} · concurrency ${cfg.concurrency} · claude ${claudeVersion ?? 'not found'}`);
    void reportAgents();
  })();
  const every = (ms: number, fn: () => void) => timers.push(setInterval(fn, ms));
  every(15_000, () => void heartbeat());
  every(60_000, () => void reportAgents());
  void connectLoop();

  return {
    jobs,
    async stop() {
      ac.abort();
      timers.forEach(clearInterval);
      for (const j of jobs.values()) j.stop('runner shutting down');
      await Promise.race([Promise.all([...jobs.values()].map((j) => j.done)), new Promise((r) => setTimeout(r, (cfg.stopGraceSeconds + 5) * 1000))]);
    },
  };
}

export async function runRunner(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { config: { type: 'string' } }, allowPositionals: false });
  let runner: Runner;
  try {
    runner = startRunner({ configPath: values.config });
  } catch (e) {
    console.error(`bb runner: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  await new Promise<void>((resolve) => {
    const stop = () => void runner.stop().then(resolve);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

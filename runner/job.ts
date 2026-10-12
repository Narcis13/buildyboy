// One `claude -p` job: spawn with a validated argv (no shell), stream stdout to the server, follow-ups over
// stdin stream-json, graceful stop then kill.
import { spawn } from 'node:child_process';
import type { JobView } from '../shared/types.ts';
import type { Api } from './api.ts';
import { eventSender } from './api.ts';
import type { Exe } from './claude.ts';
import type { RunnerConfig } from './config.ts';
import type { StoredJobOptions } from './options.ts';
import { killTree } from './proc.ts';

const WIN = process.platform === 'win32';
const MAX_LINE = 200_000;

export interface RunningJob {
  id: string;
  root: string;
  cwd: string;
  startedAt: number;
  sessionId(): string | null;
  /** directory claude reported in its init message (a worktree with -w) */
  workDir(): string;
  pid(): number | undefined;
  message(text: string): boolean;
  stop(reason?: string): void;
  done: Promise<void>;
}

export const userMessage = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';

/** Splits a byte stream into lines. */
function lines(onLine: (l: string) => void) {
  let buf = '';
  return {
    push(chunk: string) {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

export function startJob(
  job: JobView, args: string[], exe: Exe, place: { cwd: string; root: string; sessionId: string },
  deps: { cfg: RunnerConfig; api: Api; log: (s: string) => void },
): RunningJob {
  const { cfg, log } = deps;
  const opts = job.options as StoredJobOptions;
  const send = eventSender(deps.api, job.id, log);
  let sessionId: string | null = opts.resumeSessionId ? null : place.sessionId;
  let workDir = place.cwd;
  let lastResult: Record<string, unknown> | null = null;
  let cost: number | null = null;
  let stopRequested: string | null = null;
  let stdinOpen = true;
  let idleTimer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let stderrTail = '';

  const env: NodeJS.ProcessEnv = { ...process.env, BUILDYBOY_JOB_ID: job.id };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.BUILDYBOY_TOKEN;
  const child = spawn(exe.command, [...exe.prefix, ...args], { cwd: place.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: !WIN });
  log(`job ${job.id}: started pid ${child.pid ?? '?'} in ${place.cwd}`);

  const closeStdin = () => {
    if (!stdinOpen) return;
    stdinOpen = false;
    try {
      child.stdin!.end();
    } catch {
      // already gone
    }
  };
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const out = lines((line) => {
    if (!line.trim()) return;
    let msg: Record<string, unknown> | null = null;
    try {
      msg = JSON.parse(line);
    } catch {
      // not JSON: keep it as raw output
    }
    if (msg?.type === 'system' && msg.subtype === 'init') {
      if (typeof msg.session_id === 'string' && msg.session_id !== sessionId) {
        sessionId = msg.session_id;
        send.push({ type: 'status', status: 'running', sessionId });
      }
      if (typeof msg.cwd === 'string') workDir = msg.cwd;
    } else if (msg?.type === 'result') {
      lastResult = msg;
      if (typeof msg.total_cost_usd === 'number') cost = Math.max(cost ?? 0, msg.total_cost_usd);
      // the turn is over; give follow-ups a window, then end the job
      clearIdle();
      idleTimer = setTimeout(closeStdin, cfg.idleExitSeconds * 1000);
    }
    send.push({ type: 'output', lines: [line.length > MAX_LINE ? JSON.stringify({ type: 'buildyboy_truncated', length: line.length, head: line.slice(0, 4000) }) : line] });
  });
  const err = lines((line) => {
    if (!line.trim()) return;
    stderrTail = (stderrTail + line + '\n').slice(-8000);
    send.push({ type: 'output', lines: [JSON.stringify({ type: 'stderr', text: line.slice(0, 8000) })] });
  });
  child.stdout!.setEncoding('utf8').on('data', (d: string) => out.push(d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => err.push(d));
  child.stdin!.on('error', () => {
    stdinOpen = false;
  });

  const write = (text: string): boolean => {
    if (!stdinOpen || !child.stdin!.writable) return false;
    clearIdle();
    child.stdin!.write(userMessage(text));
    return true;
  };

  child.on('spawn', () => {
    send.push({ type: 'status', status: 'running', sessionId: sessionId ?? undefined });
    write(job.promptText);
  });

  const limitMs = opts.limitMinutes ? opts.limitMinutes * 60_000 : 0;
  const limitTimer = limitMs ? setTimeout(() => stop(`limit of ${opts.limitMinutes} min reached`), limitMs) : null;

  function stop(reason = 'stopped from Buildyboy') {
    if (stopRequested) return;
    stopRequested = reason;
    log(`job ${job.id}: stopping (${reason})`);
    clearIdle();
    closeStdin();
    if (!WIN && child.pid) {
      try {
        process.kill(-child.pid, 'SIGINT');
      } catch {
        // already exited
      }
    }
    killTimer = setTimeout(() => killTree(child), cfg.stopGraceSeconds * 1000);
  }

  const done = new Promise<void>((resolveDone) => {
    let finished = false;
    const finish = async (code: number | null, error?: string) => {
      if (finished) return;
      finished = true;
      clearIdle();
      if (killTimer) clearTimeout(killTimer);
      if (limitTimer) clearTimeout(limitTimer);
      out.end();
      err.end();
      const r = lastResult as Record<string, unknown> | null;
      const ok = !!r && r.is_error !== true && code === 0;
      const status = stopRequested ? 'stopped' : ok ? 'succeeded' : 'failed';
      const reason = error ?? stopRequested ?? (!r ? `claude exited (code ${code}) without a result` : r.is_error ? `result: ${String(r.subtype ?? 'error')}` : code !== 0 ? `exit code ${code}` : undefined);
      send.push({
        type: 'status', status, exitCode: code, costUsd: cost, sessionId: sessionId ?? undefined,
        result: {
          ...(r ? { subtype: r.subtype, is_error: r.is_error, num_turns: r.num_turns, duration_ms: r.duration_ms, session_id: r.session_id, result: typeof r.result === 'string' ? r.result.slice(0, 4000) : undefined, permission_denials: Array.isArray(r.permission_denials) ? r.permission_denials.length : undefined } : {}),
          ...(reason && status !== 'succeeded' ? { reason } : {}),
          ...(status === 'failed' && stderrTail ? { stderr: stderrTail.slice(-2000) } : {}),
        },
      });
      log(`job ${job.id}: ${status}${reason ? ` (${reason})` : ''}`);
      await send.flush();
      send.close();
      resolveDone();
    };
    child.on('error', (e) => void finish(null, `failed to start claude: ${e.message}`));
    child.on('close', (code) => void finish(code));
  });

  return {
    id: job.id,
    root: place.root,
    cwd: place.cwd,
    startedAt: Date.now(),
    sessionId: () => sessionId,
    workDir: () => workDir,
    pid: () => child.pid,
    message: write,
    stop,
    done,
  };
}

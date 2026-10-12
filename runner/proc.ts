// Process-tree kill and the Done-when verify commands (the only non-claude execution).
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const WIN = process.platform === 'win32';

/** Kills a process and its children. Windows: taskkill /T /F; elsewhere the child leads its own process group. */
export function killTree(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (WIN) {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawn(taskkill, ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true, shell: false }).on('error', () => child.kill());
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

export interface VerifyResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
}

const CAP = 64 * 1024;

/** Runs one command with the platform shell in `cwd`, output capped at 64 KB, killed after `timeoutMs`. */
export function runCommand(command: string, cwd: string, timeoutMs = 10 * 60_000): Promise<VerifyResult> {
  return new Promise((done) => {
    let out = '';
    let dropped = 0;
    const add = (b: Buffer) => {
      const s = b.toString('utf8');
      const room = CAP - out.length;
      if (room > 0) out += s.slice(0, room);
      dropped += Math.max(0, s.length - Math.max(0, room));
    };
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: !WIN, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout!.on('data', add);
    child.stderr!.on('data', add);
    child.on('error', (e) => {
      clearTimeout(t);
      done({ command, ok: false, exitCode: null, output: `failed to start: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      let output = out;
      if (dropped) output += `\n… ${dropped} more characters truncated`;
      if (timedOut) output += `\n… timed out after ${Math.round(timeoutMs / 1000)} s`;
      done({ command, ok: code === 0 && !timedOut, exitCode: code, output });
    });
  });
}

export async function runVerify(commands: string[], cwd: string, timeoutMs?: number): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  for (const c of commands) results.push(await runCommand(c, cwd, timeoutMs));
  return results;
}

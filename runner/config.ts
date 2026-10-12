// Runner config lives on the machine (~/.buildyboy/runner.json). The server never writes it.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bbHome, readClientConfig } from '../cli/config.ts';

export interface RunnerConfig {
  allowedRoots: string[];
  concurrency: number;
  claudePath?: string;
  /** close stdin this long after a `result` with no follow-up, so the job can finish (default 120) */
  idleExitSeconds: number;
  /** after a stop, kill the process tree if it is still alive after this (default 10) */
  stopGraceSeconds: number;
  url: string;
  token: string;
  machineId?: string;
}

export function loadConfig(configPath?: string): RunnerConfig {
  const file = resolve(configPath ?? join(bbHome(), 'runner.json'));
  if (!existsSync(file)) throw new Error(`runner config not found: ${file}\nCreate it with: { "allowedRoots": ["/path/to/your/repos"], "concurrency": 2 }`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const roots = Array.isArray(raw.allowedRoots) ? raw.allowedRoots.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => resolve(r)) : [];
  if (!roots.length) throw new Error(`${file}: "allowedRoots" must list at least one directory`);
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  const client = readClientConfig();
  if (!client.url || !client.token) throw new Error(`not paired: ${join(bbHome(), 'config.json')} needs url and token (run: bb pair <code>)`);
  return {
    allowedRoots: roots,
    concurrency: Math.floor(n(raw.concurrency, 2)),
    claudePath: typeof raw.claudePath === 'string' && raw.claudePath ? raw.claudePath : undefined,
    idleExitSeconds: n(raw.idleExitSeconds, 120),
    stopGraceSeconds: n(raw.stopGraceSeconds, 10),
    url: client.url.replace(/\/$/, ''),
    token: client.token,
    machineId: client.machineId,
  };
}

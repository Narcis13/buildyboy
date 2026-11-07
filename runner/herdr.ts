// herdr (`hc`) integration on the machine side. The server never runs hc; the runner does (SPEC §11.4).
// Only two things are executed: `hc ls --json` (read) and `hc run --bg --json …` with a validated argument list.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, join, resolve } from 'node:path';
import type { Exe } from './claude.ts';

const OFF = /^(off|none|false|0)$/i;

/** hc's path: BUILDYBOY_HC, an explicit config path, herdr-core's default Windows install, then PATH. "off" disables it. */
export function findHc(configured?: string): string | null {
  const env = process.env.BUILDYBOY_HC;
  if (env && OFF.test(env.trim())) return null;
  if (!env && configured && OFF.test(configured.trim())) return null;
  const candidates = [env, configured];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'herdr-core', 'hc.exe'));
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) candidates.push(join(dir, process.platform === 'win32' ? 'hc.exe' : 'hc'));
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
}

/** The hc command to run; a .mjs/.js script (tests use a fake) goes through node. Null when hc isn't installed. */
export function resolveHc(configured?: string): Exe | null {
  const p = findHc(configured);
  if (!p) return null;
  return /^\.(mjs|js|cjs)$/i.test(extname(p)) ? { command: process.execPath, prefix: [resolve(p)] } : { command: p, prefix: [] };
}

export interface HcTerminal {
  address: string;
  name: string | null;
  agent: string | null;
  cwd: string | null;
  state: string | null;
  status: string | null;
  turn: number | null;
  where: string | null;
}

function run(hc: Exe, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((res, rej) => {
    execFile(hc.command, [...hc.prefix, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, shell: false }, (e, stdout, stderr) => {
      if (e) rej(new Error(`${String(stderr || e.message).trim().slice(0, 500)}`));
      else res(stdout);
    });
  });
}

const s = (v: unknown, max = 500): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);

/** `hc ls --json`, reduced to what the Floor shows. Throws when hc fails or prints something else. */
export async function listTerminals(hc: Exe): Promise<HcTerminal[]> {
  const out = JSON.parse(await run(hc, ['ls', '--json'], 10_000)) as { terminals?: unknown };
  if (!Array.isArray(out.terminals)) throw new Error('hc ls: no terminals list');
  const list: HcTerminal[] = [];
  for (const t of out.terminals.slice(0, 500)) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const address = s(o.address, 100);
    if (!address) continue;
    list.push({ address, name: s(o.name, 100), agent: s(o.agent, 100), cwd: s(o.cwd, 1000), state: s(o.state, 40), status: s(o.status, 40), turn: typeof o.turn === 'number' && Number.isFinite(o.turn) ? Math.floor(o.turn) : null, where: s(o.where, 300) });
  }
  return list;
}

/** `hc run --bg --json …` with an argument list built by buildHcRunArgs. Returns the new terminal's address and name. */
export async function runInTerminal(hc: Exe, args: string[]): Promise<{ address: string; name: string | null }> {
  const out = await run(hc, args, 30_000);
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(out.slice(out.indexOf('{')));
  } catch {
    throw new Error(`hc run printed something unexpected: ${out.trim().slice(0, 200)}`);
  }
  const address = s(j.address, 100);
  if (!address) throw new Error(`hc run returned no terminal address: ${out.trim().slice(0, 200)}`);
  return { address, name: s(j.name, 100) };
}

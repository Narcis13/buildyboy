// herdr (`hc`) integration on the machine side. The server never runs hc; the runner does (SPEC §11.4, §12.4).
// What is executed: `hc ls --json` (read), `hc run --bg --json …` with a validated argument list, and two checked
// commands on terminals the factory started: `hc send` and `hc kill`, only for a terminal named `bb-…` whose
// `hc get <name> --json` says that name and carries the label owner=buildyboy.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, extname, join, resolve } from 'node:path';
import type { HcCommand, HcReport } from '../shared/factory.ts';
import type { Exe } from './claude.ts';
import { writeFactoryFiles } from './kit/exec.ts';
import { checkCwd } from './paths.ts';

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

// ---------- checked commands on the factory's own terminals (§12.4) ----------

/** A factory terminal: `bb-` and 1–29 of a-z 0-9 _ - (runner/options.ts hcTerminalName, hcCoordinatorName). */
export const HC_NAME_RE = /^bb-[a-z0-9_-]{1,29}$/;
/** Longer (or multi-line) text goes to a file in the terminal's .factory/inbox/ and the sent line points at it. */
export const HC_SEND_MAX = 500;

export type Checked = { ok: true; name: string; cwd: string | null; status: string | null } | { ok: false; reason: string };

/** `hc get <name> --json`: it must be that terminal, and the factory's (label owner=buildyboy). */
export async function checkTerminal(hc: Exe, name: string): Promise<Checked> {
  if (typeof name !== 'string' || !HC_NAME_RE.test(name)) return { ok: false, reason: `refused: ${JSON.stringify(name)} is not a factory terminal name (bb-…)` };
  let j: Record<string, unknown>;
  try {
    const out = await run(hc, ['get', name, '--json'], 15_000);
    j = JSON.parse(out.slice(out.indexOf('{')));
  } catch (e) {
    return { ok: false, reason: `no terminal ${name} (${(e as Error).message.slice(0, 200)})` };
  }
  const labels = j.labels && typeof j.labels === 'object' && !Array.isArray(j.labels) ? (j.labels as Record<string, unknown>) : null;
  if (j.name !== name) return { ok: false, reason: `refused: hc get ${name} answered another terminal (${JSON.stringify(j.name ?? null)})` };
  if (!labels || labels.owner !== 'buildyboy') return { ok: false, reason: `refused: terminal ${name} does not carry the label owner=buildyboy` };
  return { ok: true, name, cwd: s(j.cwd, 1000), status: s(j.status, 40) };
}

export async function hcKill(hc: Exe, name: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const c = await checkTerminal(hc, name);
  if (!c.ok) return c;
  try {
    await run(hc, ['kill', '--json', name], 30_000);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `hc kill failed: ${(e as Error).message.slice(0, 300)}` };
  }
}

/**
 * `hc send` to a factory terminal. A long or multi-line text is written to `<terminal cwd>/.factory/inbox/<n>.md` (the
 * cwd must be inside the allowed roots) and the line sent says to read it. `files` go under that `.factory/` first.
 */
export async function hcSend(hc: Exe, cmd: Pick<HcCommand, 'name' | 'text' | 'if' | 'files'>, roots: string[]): Promise<HcReport> {
  const c = await checkTerminal(hc, cmd.name);
  if (!c.ok) return { status: 'error', error: c.reason };
  const text = typeof cmd.text === 'string' ? cmd.text.replace(/\0/g, '').trim() : '';
  if (!text) return { status: 'error', error: 'nothing to send' };
  if (cmd.if !== undefined && cmd.if !== 'idle' && cmd.if !== 'working') return { status: 'error', error: `if: idle or working, not ${JSON.stringify(cmd.if)}` };
  let line = text;
  let inbox: string | null = null;
  if (text.length > HC_SEND_MAX || /[\r\n]/.test(text) || cmd.files?.length) {
    const where = checkCwd(c.cwd, roots);
    if (!where.ok) return { status: 'error', error: `cannot write the message file: the terminal's folder is not usable (${where.reason})` };
    try {
      writeFactoryFiles(where.cwd, cmd.files);
      if (text.length > HC_SEND_MAX || /[\r\n]/.test(text)) {
        const dir = join(where.cwd, '.factory', 'inbox');
        mkdirSync(dir, { recursive: true });
        const n = Math.max(0, ...readdirSync(dir).map((f) => /^(\d+)\.md$/.exec(f)?.[1]).filter(Boolean).map(Number)) + 1;
        writeFileSync(join(dir, `${n}.md`), `${text}\n`);
        inbox = `.factory/inbox/${n}.md`;
        line = `Read ${inbox}: a message from the factory. Act on it, then go on.`;
      }
    } catch (e) {
      return { status: 'error', error: `cannot write the message file: ${(e as Error).message}` };
    }
  }
  if (line.startsWith('-')) line = `Message: ${line}`;
  try {
    await run(hc, ['send', '--json', ...(cmd.if ? ['--if', cmd.if] : []), cmd.name, line], 60_000);
  } catch (e) {
    return { status: 'error', error: `not sent: ${(e as Error).message.slice(0, 300)}`, ...(inbox ? { result: { inbox } } : {}) };
  }
  return { status: 'done', result: { sent: true, ...(inbox ? { inbox } : {}) } };
}

/** The runner's `{type: 'hc'}` command. */
export async function runHcCommand(hc: Exe | null, cmd: HcCommand, roots: string[]): Promise<HcReport> {
  if (!hc) return { status: 'error', error: 'herdr (hc) is not installed on this machine' };
  if (cmd.op === 'kill') {
    const r = await hcKill(hc, cmd.name);
    return r.ok ? { status: 'done', result: { killed: true } } : { status: 'error', error: r.reason };
  }
  if (cmd.op === 'send') return hcSend(hc, cmd, roots);
  return { status: 'error', error: `unknown hc op ${JSON.stringify((cmd as { op?: unknown }).op)}` };
}

// `bb line check [dir]` (SPEC §12.8): validates a repo's line file (factory.json, §12.3) and prints the resolved line, or
// the errors with exit code 1. Reads only; runs nothing.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GATES } from '../shared/factory.ts';
import { argvStepsOf, enabledGates, fill, fillCommand, LINE_FILE_DEFAULT, lineVars, resolveLine, type ResolvedLine } from '../shared/line.ts';

const USAGE = 'usage: bb line check [dir] [--file <line file>] [--id <sample package id>] [--json]';

export async function lineCli(args: string[], out: (s: string) => void = (s) => console.log(s), err: (s: string) => void = (s) => console.error(s)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { file: { type: 'string' }, id: { type: 'string' }, json: { type: 'boolean' } } });
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 1;
  }
  const [sub, dirArg] = parsed.positionals;
  if (sub !== 'check') {
    err(USAGE);
    return 1;
  }
  const dir = resolve(dirArg ?? '.');
  const rel = parsed.values.file ?? LINE_FILE_DEFAULT;
  const file = resolve(dir, rel);
  if (!existsSync(file)) {
    err(`${file}: no line file (create ${LINE_FILE_DEFAULT}; {"commands": {"verify": "npm test"}} is a working line)`);
    return 1;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    err(`${file}: not valid JSON: ${(e as Error).message}`);
    return 1;
  }
  const r = resolveLine(raw, { checkoutDir: dir, file: rel });
  if (!r.ok) {
    err(`${file}: ${r.errors.length} error${r.errors.length > 1 ? 's' : ''}`);
    for (const e of r.errors) err(`  - ${e}`);
    return 1;
  }
  if (parsed.values.json) {
    out(JSON.stringify(r.line, null, 2));
    return 0;
  }
  let sample;
  try {
    const v = lineVars(r.line, { id: parsed.values.id ?? 'P1', round: 1 }, '');
    sample = { ...v, worktree: resolve(dir, fill(r.line.worktree, v)) };
  } catch (e) {
    err(`--id: ${(e as Error).message}`);
    return 1;
  }
  for (const l of describe(r.line, sample, file)) out(l);
  for (const w of r.warnings) out(`warning: ${w}`);
  return 0;
}

function describe(line: ResolvedLine, v: ReturnType<typeof lineVars>, file: string): string[] {
  const c = line.commands;
  const cmd = (s?: string) => (s ? fillCommand(line, s, v, process.platform) : '(none)');
  const gate = (g: (typeof GATES)[number]) => {
    if (!line.enabled[g]) return 'off';
    if (argvStepsOf(line, g)) return `argv steps (${argvStepsOf(line, g)!.length})`;
    if (g === 'G1') return `commands.verify: ${cmd(c.verify)}`;
    if (g === 'G2') return `commands.acceptance: ${cmd(c.acceptance)}${line.gates.G2.qa ? ', after QA' : ''}`;
    if (g === 'G3') return `claude -p review (${line.models.review}), security pass: ${line.gates.G3.security}`;
    if (g === 'G4') return `commands.shots: ${cmd(c.shots)}${c.app ? `, app: ${cmd(c.app)}` : ''}, judge ${line.models.visual}${line.gates.G4.chrome ? ' with Chrome' : ''}`;
    return `merge origin/${line.base}, G1 and G2 again, fast-forward ${line.base}${line.gates.G5.push ? ', push' : ''}`;
  };
  return [
    `line file: ${file}${line.legacy ? ' (a §11.7 recipe: only its argv steps run)' : ''}`,
    `enabled gates: ${enabledGates(line).join(' ') || 'none'}${line.qa ? ' · QA before the build' : ''}`,
    ...GATES.map((g) => `  ${g}: ${gate(g)}`),
    `base: ${line.base}`,
    `for package ${v.id}: branch ${v.branch} · worktree ${v.worktree}`,
    `commands: setup ${cmd(c.setup)} · cleanup ${cmd(c.cleanup)}`,
    `paths: acceptance ${fill(line.paths.acceptance, v)} · shots ${fill(line.paths.shots, v)} · packages ${line.paths.packages}${line.paths.protected.length ? ` · protected ${line.paths.protected.join(', ')}` : ''}`,
    `env: ${Object.keys(line.env).join(', ') || '(none)'} → ${line.envFile}`,
    `resources: ${line.resources ? JSON.stringify(line.resources) : '(none: the project config decides)'}`,
    `models: ${Object.entries(line.models).map(([k, m]) => `${k} ${m ?? 'off'}`).join(', ')}`,
    `worker: ${line.worker.launcher}, ${line.worker.permissionMode}, ${line.worker.limitHours} h, ${line.worker.subagents} subagents · limits: ${line.limits.workers} workers${line.limits.rounds ? `, ${line.limits.rounds} rounds` : ''} · integrate approval: ${line.integrate.approval}`,
    `context: ${line.context.join(', ') || '(none)'}`,
  ];
}

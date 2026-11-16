// The kit's built-in steps (SPEC §12.4): prepare, qa, G1–G5, cleanup and revert. Each returns the step contract of §11.7
// ({verdict, summary, details?, findings?, shots?}) or throws KitError, which the gate runner reports as an error (no
// verdict, no round used). Command lines come only from the line file of the trusted main checkout; the server's data
// (the package, findings, files) only fills prompts and files under `.factory/`. Every step that runs the package's code
// stops the leftover processes of its worktree and port before and after: an orphaned dev server gives false failures.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { FindingInput, GateCommand, StepName, StepPackage, Verdict } from '../../shared/factory.ts';
import { acceptanceRoot, fill, fillCommand, lineEnv, validRef, type ResolvedLine } from '../../shared/line.ts';
import type { TaskVars } from '../../shared/factory.ts';
import type { Exe } from '../claude.ts';
import { hcKill } from '../herdr.ts';
import { hcTerminalName } from '../options.ts';
import { killTree } from '../proc.ts';
import { git, gitOk, KitError, runCommandLine, shellArgv, spawnCapture, testSummary, writeFactoryFiles, type Outcome } from './exec.ts';
import { stopLeftovers } from './procs.ts';
import { firstSentence, runVerifier, type VerifierOpts } from './verifier.ts';

const KIT_DIR = new URL('../../shared/kit/', import.meta.url);
const kitFile = (name: string) => readFileSync(new URL(name, KIT_DIR), 'utf8');
/** turns and budget of each verifier (not in the line file: the kit's own limits) */
export const VERIFIER_LIMITS = { qa: { maxTurns: 80, maxBudgetUsd: 5 }, review: { maxTurns: 60, maxBudgetUsd: 5 }, visual: { maxTurns: 60, maxBudgetUsd: 3 } };
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_SHOTS = 12;

export interface StepResult {
  verdict: Verdict;
  summary: string;
  details?: Record<string, unknown>;
  findings?: FindingInput[];
  /** image paths, absolute or relative to the checkout (at most 12 are attached) */
  shots?: unknown[];
}

export interface Kit {
  run: GateCommand['run'];
  line: ResolvedLine;
  /** the trusted main checkout (real path) */
  checkout: string;
  /** the package's worktree, computed by the runner from the line (inside the allowed roots) */
  worktree: string;
  branch: string;
  base: string;
  vars: TaskVars;
  pkg: StepPackage;
  args: string[];
  /** process env + the line's env + BB_TASK, BB_ROLE=poarta, BB_GATE… */
  env: NodeJS.ProcessEnv;
  roots: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  /** appends to the step's log */
  log: (s: string) => void;
  claude: () => Exe;
  hc: () => Exe | null;
  /** runs a gate as the line says (argv steps or the built-in); G5 uses it for G1 and G2 on the merged result */
  sub: (step: StepName) => Promise<StepResult>;
}

export type BuiltIn = (k: Kit) => Promise<StepResult>;

// ---------- helpers ----------

const posix = (p: string) => p.replace(/\\/g, '/');
const short = (sha: string) => sha.slice(0, 12);
const isWorktree = (wt: string) => existsSync(join(wt, '.git'));

function requireWorktree(k: Kit) {
  if (!isWorktree(k.worktree)) throw new KitError(`the worktree ${k.worktree} does not exist: run prepare first`);
}

/** Runs a command line of the line (placeholders filled and quoted) in `cwd`. A timeout or an abort is a KitError. */
async function command(k: Kit, what: string, cmd: string, cwd: string, timeoutMs = k.timeoutMs): Promise<Outcome & { ok: boolean; output: string }> {
  const line = fillCommand(k.line, cmd, k.vars, process.platform);
  k.log(`$ ${line}\n`);
  let out = '';
  const r = await runCommandLine(k.line, line, {
    cwd, env: k.env, timeoutMs, signal: k.signal, onData: (s) => {
      k.log(s);
      if (out.length < 4 * 1024 * 1024) out += s;
    },
  });
  if (r.kind === 'aborted') throw new KitError('runner stopped while the step was running');
  if (r.kind === 'timeout') throw new KitError(`${what} timed out after ${Math.round(timeoutMs / 1000)} s`);
  if (r.kind === 'spawn-error') throw new KitError(`${what} could not start: ${r.message ?? 'spawn failed'}`);
  return { ...r, ok: r.code === 0, output: out };
}

async function stop(k: Kit) {
  const killed = await stopLeftovers({ worktree: k.worktree, port: k.vars.port });
  if (killed.length) k.log(`stopped leftover processes: ${killed.join(', ')}\n`);
}

/** The relative acceptance folder of this package, e.g. `tests/acceptance/P1`. */
const acceptanceDir = (k: Kit) => posix(fill(k.line.paths.acceptance, k.vars)).replace(/\/+$/, '');

function packageMd(p: StepPackage): string {
  const crit = p.acceptance.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `# ${p.id}: ${p.title || '(untitled)'}\n\n${p.body.trim() || '(no description)'}\n\n## Acceptance criteria\n\n${crit || '(none)'}\n${p.sensitive ? '\nThis package is **sensitive** (auth, permissions, personal data or external effects).\n' : ''}`;
}

/** .factory/package.md from the command's package, then the server's files. */
function writeFactory(k: Kit) {
  const dir = join(k.worktree, '.factory');
  mkdirSync(dir, { recursive: true });
  if (k.pkg.title || k.pkg.body || k.pkg.acceptance.length) writeFileSync(join(dir, 'package.md'), packageMd(k.pkg));
  writeFactoryFiles(k.worktree, k.run.files);
}

/** The paths a worker may not change (§12.3): the line file, other packages' acceptance tests and paths.protected. */
export function protectedOf(k: Pick<Kit, 'line' | 'vars'>): { exact: string[]; prefixes: string[]; patterns: RegExp[]; own: string } {
  const own = posix(fill(k.line.paths.acceptance, k.vars)).replace(/\/+$/, '');
  const root = acceptanceRoot(k.line);
  const exact = [posix(k.line.file)];
  const prefixes: string[] = [];
  const patterns: RegExp[] = [];
  if (root !== null && root !== '') prefixes.push(root);
  for (const p of k.line.paths.protected) {
    const f = posix(fill(p, k.vars)).replace(/^\.\//, '');
    if (f.includes('*')) patterns.push(new RegExp(`^${f.split('**').map((s) => s.split('*').map((x) => x.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*')).join('.*')}(/.*)?$`));
    else if (f.endsWith('/')) prefixes.push(f);
    else {
      exact.push(f);
      prefixes.push(`${f}/`);
    }
  }
  return { exact, prefixes, patterns, own };
}

export function isProtectedPath(path: string, pr: ReturnType<typeof protectedOf>): boolean {
  const p = posix(path);
  if (p === pr.own || p.startsWith(`${pr.own}/`)) return false;
  return pr.exact.includes(p) || pr.prefixes.some((x) => p.startsWith(x)) || pr.patterns.some((r) => r.test(p));
}

/** .factory/guard.json for the plugin's guard (§12.8): what a worker may not write; QA may write only `acceptance`. */
function guardJson(k: Kit) {
  const pr = protectedOf(k);
  return { version: 1, taskId: k.pkg.id, lineFile: posix(k.line.file), acceptance: pr.own, protected: [...pr.exact, ...pr.prefixes.map((p) => `${p}**`), ...k.line.paths.protected.map((p) => posix(fill(p, k.vars)))], qaRole: 'qa' };
}

async function excludeFromGit(k: Kit) {
  const common = resolve(k.worktree, await gitOk(['rev-parse', '--git-common-dir'], k.worktree));
  const file = join(common, 'info', 'exclude');
  mkdirSync(join(common, 'info'), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const want = ['/.factory/', `/${posix(k.line.envFile)}`].filter((l) => !cur.split(/\r?\n/).includes(l));
  if (want.length) writeFileSync(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}# Buildyboy (SPEC §12.4)\n${want.join('\n')}\n`);
}

const fillPrompt = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, key: string) => (Object.hasOwn(v, key) ? v[key] : m));
const contextList = (k: Kit) => (k.line.context.length ? k.line.context.map((c) => `\`${c}\``).join(', ') : 'none');
function packageLine(k: Kit): string {
  return `Package: ${k.pkg.id}${k.pkg.title ? ` (${k.pkg.title.replace(/\s+/g, ' ').slice(0, 200)})` : ''}. Specification: \`.factory/package.md\`. Base: \`origin/${k.base}\`. Branch: \`${k.branch}\`. Sensitive: ${k.pkg.sensitive ? 'yes' : 'no'}. Round: ${k.vars.round}.`;
}
const noteArg = (args: string[]) => {
  const i = args.indexOf('--note');
  return i >= 0 && typeof args[i + 1] === 'string' ? args[i + 1].slice(0, 4000) : '';
};

function verifierEnv(k: Kit, role: 'qa' | 'poarta'): NodeJS.ProcessEnv {
  return { ...k.env, BB_TASK: k.pkg.id, BB_ROLE: role };
}

async function verifier(k: Kit, o: Omit<VerifierOpts, 'exe' | 'cwd' | 'env' | 'timeoutMs' | 'signal' | 'onData'>, role: 'qa' | 'poarta') {
  let exe: Exe;
  try {
    exe = k.claude();
  } catch (e) {
    throw new KitError((e as Error).message);
  }
  k.log(`claude -p (${o.model}, ${o.permissionMode}, tools: ${o.allowedTools.join(' ')})\n`);
  const a = await runVerifier({ ...o, exe, cwd: k.worktree, env: verifierEnv(k, role), timeoutMs: k.timeoutMs, signal: k.signal });
  k.log(`claude: ${a.ok ? 'answered' : a.error} ($${a.costUsd.toFixed(2)}, ${a.attempts} attempt${a.attempts > 1 ? 's' : ''})\n`);
  if (!a.ok) throw new KitError(a.error ?? 'claude gave no answer');
  return a;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const count = (f: FindingInput[], s: FindingInput['severity']) => f.filter((x) => x.severity === s).length;

// ---------- prepare ----------

export const prepare: BuiltIn = async (k) => {
  await stop(k);
  await gitOk(['fetch', 'origin'], k.checkout, { signal: k.signal });
  const baseRef = `origin/${k.base}`;
  if (!(await git(['rev-parse', '--verify', '-q', `${baseRef}^{commit}`], k.checkout)).ok) throw new KitError(`${baseRef} does not exist`);
  let created = false;
  if (isWorktree(k.worktree)) {
    const mine = resolve(k.checkout, await gitOk(['rev-parse', '--git-common-dir'], k.checkout));
    const theirs = resolve(k.worktree, await gitOk(['rev-parse', '--git-common-dir'], k.worktree));
    if (posix(mine).toLowerCase() !== posix(theirs).toLowerCase()) throw new KitError(`${k.worktree} is a checkout of another repository`);
    const on = (await git(['symbolic-ref', '--short', '-q', 'HEAD'], k.worktree)).out;
    if (on !== k.branch) throw new KitError(`the worktree ${k.worktree} is on ${on || 'a detached HEAD'}, not ${k.branch}`);
    k.log(`reusing the worktree ${k.worktree} on ${k.branch}\n`);
  } else {
    if (existsSync(k.worktree) && readdirSync(k.worktree).length) throw new KitError(`${k.worktree} exists and is not a worktree of this repository`);
    const local = (await git(['rev-parse', '--verify', '-q', `refs/heads/${k.branch}`], k.checkout)).ok;
    const remote = !local && (await git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${k.branch}`], k.checkout)).ok;
    const args = local
      ? ['worktree', 'add', k.worktree, k.branch]
      : remote
        ? ['worktree', 'add', '--track', '-b', k.branch, k.worktree, `origin/${k.branch}`]
        : ['worktree', 'add', '--no-track', '-b', k.branch, k.worktree, baseRef];
    k.log(`$ git ${args.join(' ')}\n`);
    await gitOk(args, k.checkout, { signal: k.signal });
    created = true;
  }
  // the env file and .factory/ stay out of git
  const env = lineEnv(k.line, k.vars);
  writeFileSync(join(k.worktree, k.line.envFile), `# written by Buildyboy from ${posix(k.line.file)} (SPEC §12.3)\n${Object.entries(env).map(([n, v]) => `${n}=${v}`).join('\n')}\n`);
  await excludeFromGit(k);
  writeFactory(k);
  writeFileSync(join(k.worktree, '.factory', 'guard.json'), `${JSON.stringify(guardJson(k), null, 2)}\n`);
  const head = await gitOk(['rev-parse', 'HEAD'], k.worktree);
  const details = { worktree: k.worktree, branch: k.branch, base: k.base, created, head };
  const what = `${created ? 'created' : 'reused'} ${k.worktree} on ${k.branch} (${short(head)})`;
  if (k.line.commands.setup) {
    const r = await command(k, 'setup', k.line.commands.setup, k.worktree);
    await stop(k);
    if (!r.ok) return { verdict: 'fail', summary: `prepare: ${what}; setup failed (exit ${r.code}). ${testSummary(r.output, true)}`, details };
    return { verdict: 'pass', summary: `prepare: ${what}; setup ok`, details };
  }
  return { verdict: 'pass', summary: `prepare: ${what}`, details };
};

// ---------- qa ----------

export const qa: BuiltIn = async (k) => {
  requireWorktree(k);
  writeFactory(k);
  const acc = acceptanceDir(k);
  const tag = `bb-acceptance/${k.pkg.id}`;
  if (!validRef(tag)) throw new KitError(`cannot tag ${tag}: not a valid git name`);
  const before = await gitOk(['rev-parse', 'HEAD'], k.worktree);
  const accCmd = k.line.commands.acceptance ? fillCommand(k.line, k.line.commands.acceptance, k.vars, process.platform) : '(no acceptance command)';
  const prompt = `${fillPrompt(kitFile('qa.md'), { context: contextList(k), acceptance: acc, id: k.pkg.id, command: accCmd }).trim()}\n\n${packageLine(k)}${noteArg(k.args) ? `\n\nNote for this run: ${noteArg(k.args)}` : ''}`;
  const a = await verifier(k, {
    prompt, model: k.line.models.qa, permissionMode: 'dontAsk', ...VERIFIER_LIMITS.qa,
    allowedTools: ['Read', 'Grep', 'Glob', `Edit(${acc}/**)`, `Write(${acc}/**)`, 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)'],
  }, 'qa');
  const details: Record<string, unknown> = { costUsd: round2(a.costUsd), answer: a.result.slice(0, 4000) };
  const head = await gitOk(['rev-parse', 'HEAD'], k.worktree);
  if (head === before) return { verdict: 'fail', summary: `QA ($${a.costUsd.toFixed(2)}): no commit; the acceptance tests must be committed in ${acc}`, details };
  const inside = (p: string) => p === acc || p.startsWith(`${acc}/`);
  const changes = (await gitOk(['diff', '--name-status', '--no-renames', before, head], k.worktree)).split(/\r?\n/).filter(Boolean).map((l) => {
    const [s, ...p] = l.split('\t');
    return { status: s, path: posix(p.join('\t')) };
  });
  const dirty = (await gitOk(['status', '--porcelain', '--untracked-files=all'], k.worktree)).split(/\r?\n/).filter(Boolean).map((l) => posix(l.slice(3)).replace(/^"|"$/g, ''));
  const outside = [...new Set([...changes.map((c) => c.path), ...dirty].filter((p) => !inside(p)))];
  details.commit = head;
  if (outside.length) return { verdict: 'fail', summary: `QA changed files outside ${acc}: ${outside.slice(0, 20).join(', ')}`, details };
  const added = changes.filter((c) => c.status === 'A' && !/(^|\/)(MANUAL|CONTRACT)\.md$/i.test(c.path)).map((c) => c.path);
  details.files = added;
  if (!added.length) return { verdict: 'fail', summary: `QA added no test file under ${acc}`, details };
  await gitOk(['tag', '-f', tag, head], k.worktree);
  details.tag = tag;
  const manual = existsSync(join(k.worktree, acc, 'MANUAL.md'));
  return { verdict: 'pass', summary: `QA ($${a.costUsd.toFixed(2)}): ${added.length} test file${added.length > 1 ? 's' : ''} in ${acc} at ${short(head)}, tag ${tag}${manual ? `; ${acc}/MANUAL.md lists checks for the owner` : ''}`, details };
};

// ---------- G1 ----------

export const G1: BuiltIn = async (k) => {
  const cmd = k.line.commands.verify;
  if (!cmd) return { verdict: 'skip', summary: 'G1 is off: the line has no commands.verify' };
  requireWorktree(k);
  await stop(k);
  const r = await command(k, 'commands.verify', cmd, k.worktree).finally(() => stop(k));
  return { verdict: r.ok ? 'pass' : 'fail', summary: `G1 ${r.ok ? 'pass' : `fail (exit ${r.code})`}. ${testSummary(r.output, !r.ok)}`.trim(), details: { exitCode: r.code } };
};

// ---------- G2 ----------

const lines = (s: string) => s.split(/\r?\n/).map((l) => posix(l.trim())).filter(Boolean);

export const G2: BuiltIn = async (k) => {
  const cmd = k.line.commands.acceptance;
  if (!cmd) return { verdict: 'skip', summary: 'G2 is off: the line has no commands.acceptance' };
  requireWorktree(k);
  const acc = acceptanceDir(k);
  const tag = `bb-acceptance/${k.pkg.id}`;
  const fetched = await git(['fetch', 'origin'], k.worktree, { signal: k.signal });
  if (!fetched.ok) k.log(`git fetch failed: ${fetched.err}\n`);
  const baseRef = `origin/${k.base}`;
  const hasTag = (await git(['rev-parse', '--verify', '-q', `refs/tags/${tag}`], k.worktree)).ok;
  if (k.line.qa) {
    if (!hasTag) throw new KitError(`the local tag ${tag} (the QA commit) is missing: run qa first`);
    const changed = [...lines((await gitOk(['diff', '--name-only', tag, '--', `${acc}/`], k.worktree))), ...lines(await gitOk(['ls-files', '--others', '--exclude-standard', '--', `${acc}/`], k.worktree))];
    if (changed.length) return { verdict: 'fail', summary: `G2 fail: the acceptance tests of ${k.pkg.id} differ from the QA commit (${tag}): ${[...new Set(changed)].slice(0, 20).join(', ')}` };
  }
  const root = acceptanceRoot(k.line);
  if (root !== null) {
    const scope = root || '.';
    const touched = new Set([...lines(await gitOk(['diff', '--name-only', `${baseRef}...HEAD`, '--', scope], k.worktree)), ...lines(await gitOk(['diff', '--name-only', 'HEAD', '--', scope], k.worktree))]);
    let byQa = new Set<string>();
    if (hasTag) {
      const mb = (await git(['merge-base', baseRef, tag], k.worktree)).out;
      if (mb) byQa = new Set(lines(await gitOk(['diff', '--name-only', mb, tag, '--', scope], k.worktree)));
    }
    const others: string[] = [];
    for (const f of touched) {
      if (f === acc || f.startsWith(`${acc}/`)) continue;
      // a test of another package may differ only as the QA commit of this package changed it (QA adapted an old test)
      if (byQa.has(f) && (await git(['diff', '--quiet', tag, '--', f], k.worktree)).ok) continue;
      others.push(f);
    }
    if (root !== '' && others.length) return { verdict: 'fail', summary: `G2 fail: the branch touched other packages' acceptance tests: ${others.slice(0, 20).join(', ')}` };
  }
  await stop(k);
  const r = await command(k, 'commands.acceptance', cmd, k.worktree).finally(() => stop(k));
  const manual = existsSync(join(k.worktree, acc, 'MANUAL.md')) ? ` For the owner to check by hand: ${acc}/MANUAL.md.` : '';
  return { verdict: r.ok ? 'pass' : 'fail', summary: `G2 ${r.ok ? 'pass, the acceptance tests are untouched' : `fail (exit ${r.code})`}. ${testSummary(r.output, !r.ok)}${manual}`.trim(), details: { exitCode: r.code, ...(manual ? { manual: `${acc}/MANUAL.md` } : {}) } };
};

// ---------- G3 ----------

interface ReviewFinding { severity?: string; category?: string; file?: string; line?: number; description?: string; fix?: string }

function reviewFindings(raw: unknown): FindingInput[] {
  if (!Array.isArray(raw)) return [];
  return (raw as ReviewFinding[]).flatMap((f): FindingInput[] => {
    if (!f || typeof f !== 'object') return [];
    const severity = (['blocker', 'major', 'minor'] as const).find((s) => s === f.severity) ?? 'minor';
    const out: FindingInput = { severity, title: firstSentence(f.description) };
    if (typeof f.file === 'string' && f.file.trim()) out.file = f.file.trim().slice(0, 1000);
    if (typeof f.line === 'number' && Number.isInteger(f.line) && f.line >= 0) out.line = f.line;
    const detail = [f.category ? `${f.category}:` : '', String(f.description ?? '').trim()].filter(Boolean).join(' ');
    if (detail) out.detail = detail.slice(0, 20_000);
    if (typeof f.fix === 'string' && f.fix.trim()) out.fix = f.fix.trim().slice(0, 20_000);
    return [out];
  });
}

function earlierFindings(k: Kit): string {
  const f = (k.run.findings ?? []).filter((x) => x && typeof x.title === 'string').slice(0, 50);
  if (!f.length || Number(k.vars.round) < 2) return '';
  const items = f.map((x) => `- [${x.severity}] ${x.title}${x.file ? ` (${x.file}${x.line != null ? `:${x.line}` : ''})` : ''}${x.detail ? `: ${String(x.detail).slice(0, 600)}` : ''}${x.fix ? ` Fix: ${String(x.fix).slice(0, 400)}` : ''}`);
  return `\n\n**Earlier open findings** (from round ${Number(k.vars.round) - 1} or before). Check first that each one is fixed; report again, with the same severity, those that are not:\n${items.join('\n')}`;
}

export const G3: BuiltIn = async (k) => {
  requireWorktree(k);
  writeFactory(k);
  const fetched = await git(['fetch', 'origin'], k.worktree, { signal: k.signal });
  if (!fetched.ok) k.log(`git fetch failed: ${fetched.err}\n`);
  const sec = k.line.gates.G3.security;
  const security = sec !== 'never' && (sec === 'always' || k.args.includes('--security') || (sec === 'sensitive' && k.pkg.sensitive));
  const review = fillPrompt(kitFile('review.md'), { base: k.base, context: contextList(k) }).trim();
  const schema = JSON.parse(kitFile('review.schema.json'));
  const note = noteArg(k.args);
  const tail = `\n\n${packageLine(k)}${earlierFindings(k)}${note ? `\n\nNote for this round: ${note}` : ''}`;
  const passes = [{ focus: 'general', prompt: review + tail }, ...(security ? [{ focus: 'security', prompt: `${review}\n\n${kitFile('review-security.md').trim()}${tail}` }] : [])];
  const findings: FindingInput[] = [];
  const done: { focus: string; verdict: string; costUsd: number; summary: string }[] = [];
  let cost = 0;
  let failed = false;
  for (const p of passes) {
    const a = await verifier(k, {
      prompt: p.prompt, schema, model: k.line.models.review, permissionMode: 'dontAsk', ...VERIFIER_LIMITS.review,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)'],
    }, 'poarta');
    const f = reviewFindings(a.output!.findings);
    const v = a.output!.verdict === 'fail' || f.some((x) => x.severity !== 'minor') ? 'fail' : 'pass';
    if (v === 'fail') failed = true;
    cost += a.costUsd;
    findings.push(...f);
    done.push({ focus: p.focus, verdict: v, costUsd: round2(a.costUsd), summary: String(a.output!.summary ?? '').slice(0, 2000) });
  }
  const verdict: Verdict = failed ? 'fail' : 'pass';
  const summary = `G3 ${verdict} ($${cost.toFixed(2)}${security ? ', with the security review' : ''}): ${count(findings, 'blocker')} blocker, ${count(findings, 'major')} major, ${count(findings, 'minor')} minor. ${done.map((d) => (passes.length > 1 ? `${d.focus}: ${d.summary}` : d.summary)).join(' ')}`;
  return { verdict, summary: summary.trim().slice(0, 8000), findings, details: { costUsd: round2(cost), passes: done } };
};

// ---------- G4 ----------

interface VisualFinding { shot?: string; rule?: number; severity?: string; description?: string; fix?: string }

/** The judge's problems as findings, and the verdict rule of visual.md. */
export function visualVerdict(out: Record<string, unknown>): { verdict: Verdict; findings: FindingInput[] } {
  const raw = Array.isArray(out.findings) ? (out.findings as VisualFinding[]) : [];
  const findings: FindingInput[] = [];
  const perShot = new Map<string, number>();
  let fail = out.verdict === 'fail';
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const severity = f.severity === 'blocker' ? 'blocker' : 'minor';
    const rule = Number.isInteger(f.rule) ? (f.rule as number) : 0;
    const shot = typeof f.shot === 'string' ? f.shot.trim().slice(0, 1000) : '';
    if (severity === 'blocker' || [1, 2, 3, 6].includes(rule)) fail = true;
    if (severity === 'minor') perShot.set(shot, (perShot.get(shot) ?? 0) + 1);
    const out: FindingInput = { severity, title: firstSentence(f.description) };
    if (shot) out.file = shot;
    out.detail = [rule ? `rule ${rule}` : '', shot ? `shot ${shot}` : '', String(f.description ?? '').trim()].filter(Boolean).join(' · ').slice(0, 20_000);
    if (typeof f.fix === 'string' && f.fix.trim()) out.fix = f.fix.trim().slice(0, 20_000);
    findings.push(out);
  }
  if ([...perShot.values()].some((n) => n >= 3)) fail = true;
  return { verdict: fail ? 'fail' : 'pass', findings };
}

function listShots(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const all = readdirSync(dir).filter((f) => IMAGE.has(extname(f).toLowerCase()) && statSync(join(dir, f)).isFile()).sort();
  // desktop first, then the rest (arond's order)
  return [...all.filter((f) => f.includes('-desktop')), ...all.filter((f) => !f.includes('-desktop'))].map((f) => join(dir, f));
}

async function waitReady(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const end = Date.now() + timeoutMs;
  let last = 'no answer';
  while (Date.now() < end) {
    if (signal?.aborted) throw new KitError('runner stopped while the step was running');
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
      if (r.status < 400) return `${r.status}`;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new KitError(`the app did not answer on ${url} within ${Math.round(timeoutMs / 1000)} s (${last})`);
}

export const G4: BuiltIn = async (k) => {
  const shotsCmd = k.line.commands.shots;
  if (!shotsCmd) return { verdict: 'skip', summary: 'G4 is off: the line has no commands.shots' };
  requireWorktree(k);
  writeFactory(k);
  const rel = posix(fill(k.line.paths.shots, k.vars)).replace(/\/+$/, '');
  const dir = resolve(k.worktree, rel);
  await stop(k);
  const r = await command(k, 'commands.shots', shotsCmd, k.worktree);
  if (!r.ok) {
    await stop(k);
    return { verdict: 'fail', summary: `G4 fail: commands.shots failed (exit ${r.code}). ${testSummary(r.output, true)}`.trim() };
  }
  const shots = listShots(dir);
  if (!shots.length) {
    await stop(k);
    return { verdict: 'skip', summary: `G4 skip: the package produced no screenshots in ${rel}` };
  }
  let app: ReturnType<typeof spawn> | null = null;
  let url = '';
  try {
    if (k.line.commands.app) {
      url = fill(k.line.app.url ?? 'http://localhost:{port}', k.vars);
      const line = fillCommand(k.line, k.line.commands.app, k.vars, process.platform);
      const { argv, verbatim } = shellArgv(k.line, line);
      k.log(`$ ${line} (in the background)\n`);
      app = spawn(argv[0], argv.slice(1), { cwd: k.worktree, env: k.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', windowsVerbatimArguments: verbatim, stdio: ['ignore', 'pipe', 'pipe'] });
      app.on('error', () => {});
      app.stdout!.on('data', (b: Buffer) => k.log(b.toString('utf8')));
      app.stderr!.on('data', (b: Buffer) => k.log(b.toString('utf8')));
      const ready = `${url.replace(/\/+$/, '')}${k.line.app.readyPath}`;
      k.log(`waiting for ${ready}: ${await waitReady(ready, k.line.app.readyTimeoutSec * 1000, k.signal)}\n`);
    }
    const chrome = k.line.gates.G4.chrome;
    const appText = url ? fillPrompt(kitFile('visual-app.md'), { url }).trim() : 'The app is not running for this check: judge from the screenshots alone.';
    const names = shots.map((s) => posix(relative(k.worktree, s)));
    const note = noteArg(k.args);
    const prompt = `${fillPrompt(kitFile('visual.md'), { app: chrome && url ? appText : url ? `The app is running at ${url}.` : appText }).trim()}\n\n${packageLine(k)} Screenshots (${names.length}): ${names.map((n) => `\`${n}\``).join(', ')}.${note ? `\n\nNote for this round: ${note}` : ''}`;
    const a = await verifier(k, {
      prompt, schema: JSON.parse(kitFile('visual.schema.json')), model: k.line.models.visual, permissionMode: 'dontAsk', chrome, ...VERIFIER_LIMITS.visual,
      allowedTools: ['Read', 'Glob', ...(chrome ? ['mcp__claude-in-chrome__*'] : [])],
    }, 'poarta');
    const { verdict, findings } = visualVerdict(a.output!);
    const summary = `G4 ${verdict} ($${a.costUsd.toFixed(2)}): ${count(findings, 'blocker')} blocker, ${count(findings, 'minor')} minor, ${shots.length} screenshot${shots.length > 1 ? 's' : ''}. ${String(a.output!.summary ?? '').slice(0, 2000)}`;
    return { verdict, summary: summary.trim(), findings, shots: shots.slice(0, MAX_SHOTS), details: { costUsd: round2(a.costUsd), shots: names.length, ...(url ? { app: url } : {}) } };
  } finally {
    if (app) killTree(app);
    await stop(k);
  }
};

// ---------- G5 ----------

export const G5: BuiltIn = async (k) => {
  requireWorktree(k);
  const baseRef = `origin/${k.base}`;
  await gitOk(['fetch', 'origin'], k.checkout, { signal: k.signal });
  const changed = lines(await gitOk(['diff', '--name-only', `${baseRef}...HEAD`], k.worktree));
  const pr = protectedOf(k);
  const hits = changed.filter((p) => isProtectedPath(p, pr));
  if (hits.length && !k.args.includes('--allow-protected')) throw new KitError(`needs approval: ${hits.join(', ')}`);
  if ((await git(['merge-base', '--is-ancestor', 'HEAD', baseRef], k.worktree)).ok) {
    const at = await gitOk(['rev-parse', baseRef], k.checkout);
    return { verdict: 'pass', summary: `G5 pass: ${k.branch} is already in ${baseRef} (${short(at)}); nothing to integrate`, details: { already: true, head: at } };
  }
  const dirty = lines(await gitOk(['status', '--porcelain', '--untracked-files=no'], k.worktree));
  if (dirty.length) return { verdict: 'fail', summary: `G5 fail: the worktree has uncommitted changes: ${dirty.slice(0, 20).join(', ')}` };
  const old = await gitOk(['rev-parse', baseRef], k.checkout);
  // 1. merge (never rebase: the branch is published) origin/<base> into the branch, in the worktree
  const m = await git(['merge', '--no-edit', baseRef], k.worktree, { signal: k.signal });
  if (!m.ok) {
    const conflicts = lines((await git(['diff', '--name-only', '--diff-filter=U'], k.worktree)).out);
    await git(['merge', '--abort'], k.worktree);
    if (!conflicts.length) throw new KitError(`git merge ${baseRef} failed: ${(m.err || m.out).slice(0, 600)}`);
    return { verdict: 'fail', summary: `G5 fail: merging ${baseRef} into ${k.branch} conflicts in ${conflicts.join(', ')}; the merge was aborted`, findings: conflicts.slice(0, 50).map((f) => ({ severity: 'blocker', title: `Merge conflict with ${baseRef}`, file: f, fix: `merge ${baseRef} into ${k.branch} and resolve the conflict` })) };
  }
  // 2. G1 and G2 again on the result
  for (const g of ['G1', 'G2'] as const) {
    if (!k.line.enabled[g]) continue;
    k.log(`--- ${g} on the merged result ---\n`);
    const r = await k.sub(g);
    if (r.verdict === 'fail') return { verdict: 'fail', summary: `G5 fail: after merging ${baseRef}, ${r.summary}`, findings: r.findings, details: { gate: g } };
  }
  // 3. in the main checkout: fast-forward <base> to the branch, then push both
  const on = (await git(['symbolic-ref', '--short', '-q', 'HEAD'], k.checkout)).out;
  if (on !== k.base) throw new KitError(`the main checkout is on ${on || 'a detached HEAD'}, not ${k.base}`);
  await gitOk(['merge', '--ff-only', baseRef], k.checkout);
  await gitOk(['merge', '--ff-only', k.branch], k.checkout);
  const nu = await gitOk(['rev-parse', 'HEAD'], k.checkout);
  const push = k.line.gates.G5.push;
  if (push) await gitOk(['push', 'origin', k.base, k.branch], k.checkout, { signal: k.signal });
  const range = `${old}..${nu}`;
  return {
    verdict: 'pass',
    summary: `G5 pass: ${k.pkg.id} integrated into ${k.base}: ${range}${push ? ', pushed' : ' (not pushed: gates.G5.push is false)'}${hits.length ? `; protected paths changed with approval: ${hits.join(', ')}` : ''}`,
    details: { range, old, new: nu, pushed: push, ...(hits.length ? { protected: hits } : {}) },
  };
};

// ---------- cleanup ----------

export const cleanup: BuiltIn = async (k) => {
  await gitOk(['fetch', 'origin'], k.checkout, { signal: k.signal });
  const baseRef = `origin/${k.base}`;
  if (k.branch === k.base) throw new KitError(`the package's branch is ${k.base} itself`);
  const local = (await git(['rev-parse', '--verify', '-q', `refs/heads/${k.branch}`], k.checkout)).ok;
  const remote = (await git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${k.branch}`], k.checkout)).ok;
  const ref = local ? k.branch : remote ? `origin/${k.branch}` : null;
  if (!ref && !isWorktree(k.worktree)) return { verdict: 'pass', summary: `cleanup ${k.pkg.id}: nothing to clean (no branch ${k.branch}, no worktree)` };
  if (!ref || !(await git(['merge-base', '--is-ancestor', ref, baseRef], k.checkout)).ok) {
    return { verdict: 'fail', summary: `cleanup refused: ${k.branch} is not integrated in ${baseRef}` };
  }
  const did: string[] = [];
  const hc = k.hc();
  if (hc) {
    const name = hcTerminalName(k.pkg.id);
    const r = await hcKill(hc, name);
    did.push(r.ok ? `terminal ${name} ended` : `terminal ${name}: ${r.reason}`);
  }
  await stop(k);
  if (isWorktree(k.worktree)) {
    const r = await git(['worktree', 'remove', k.worktree], k.checkout);
    if (!r.ok) return { verdict: 'fail', summary: `cleanup ${k.pkg.id}: the worktree ${k.worktree} was not removed: ${(r.err || r.out).split(/\r?\n/)[0]}`, details: { did } };
    did.push('worktree removed');
  }
  await git(['worktree', 'prune'], k.checkout);
  if (local) {
    await gitOk(['branch', '-D', k.branch], k.checkout);
    did.push(`branch ${k.branch} deleted`);
  }
  if (k.line.commands.cleanup) {
    const r = await command(k, 'commands.cleanup', k.line.commands.cleanup, k.checkout);
    if (!r.ok) return { verdict: 'fail', summary: `cleanup ${k.pkg.id}: ${did.join('; ')}; commands.cleanup failed (exit ${r.code}). ${testSummary(r.output, true)}`, details: { did } };
    did.push('commands.cleanup ok');
  }
  return { verdict: 'pass', summary: `cleanup ${k.pkg.id}: ${did.join('; ') || 'nothing to clean'}`, details: { did } };
};

// ---------- revert ----------

const RANGE_RE = /^([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})$/i;

export const revert: BuiltIn = async (k) => {
  const m = k.args.map((a) => RANGE_RE.exec(a.trim())).find(Boolean);
  if (!m) throw new KitError('revert needs the range of the integration, <old>..<new> (the G5 summary)');
  const [, old, nu] = m;
  await gitOk(['fetch', 'origin'], k.checkout, { signal: k.signal });
  const on = (await git(['symbolic-ref', '--short', '-q', 'HEAD'], k.checkout)).out;
  if (on !== k.base) throw new KitError(`the main checkout is on ${on || 'a detached HEAD'}, not ${k.base}`);
  await gitOk(['merge', '--ff-only', `origin/${k.base}`], k.checkout);
  for (const c of [old, nu]) if (!(await git(['merge-base', '--is-ancestor', c, 'HEAD'], k.checkout)).ok) throw new KitError(`${c} is not on ${k.base}`);
  const before = await gitOk(['rev-parse', 'HEAD'], k.checkout);
  const merges = lines(await gitOk(['rev-list', '--merges', `${old}..${nu}`], k.checkout));
  if (!merges.length) {
    await gitOk(['revert', '--no-edit', `${old}..${nu}`], k.checkout);
  } else {
    // a range with merge commits (G5 merges the base into the branch): one commit that restores <old>'s tree for those changes
    const patch = await git(['diff', '--binary', nu, old], k.checkout);
    if (!patch.ok) throw new KitError(`git diff failed: ${patch.err}`);
    const r = await spawnCapture(['git', 'apply', '--index', '--3way', '-'], { cwd: k.checkout, env: k.env, timeoutMs: 120_000, input: `${patch.out}\n` });
    if (r.code !== 0) {
      await git(['reset', '--keep', before], k.checkout);
      throw new KitError(`the revert does not apply cleanly on ${k.base}: ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
    }
    await gitOk(['commit', '-m', `Revert ${k.pkg.id} (${old}..${nu})`], k.checkout);
  }
  const after = await gitOk(['rev-parse', 'HEAD'], k.checkout);
  if (k.line.commands.verify) {
    const r = await command(k, 'commands.verify', k.line.commands.verify, k.checkout);
    if (!r.ok) {
      await git(['reset', '--keep', before], k.checkout);
      return { verdict: 'fail', summary: `revert of ${old}..${nu}: G1 fails on the result (exit ${r.code}), so it was undone and not pushed. ${testSummary(r.output, true)}`, details: { range: `${old}..${nu}` } };
    }
  }
  const push = k.line.gates.G5.push;
  if (push) await gitOk(['push', 'origin', k.base], k.checkout, { signal: k.signal });
  return { verdict: 'pass', summary: `revert: ${old}..${nu} reverted on ${k.base} at ${short(after)}${push ? ', pushed' : ''}`, details: { range: `${old}..${nu}`, revert: after, before, pushed: push } };
};

export const BUILT_INS: Record<string, BuiltIn> = { prepare, qa, G1, G2, G3, G4, G5, cleanup, revert };

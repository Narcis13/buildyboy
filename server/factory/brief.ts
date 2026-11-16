// What the conductor writes for a worker (SPEC §12.5 "The brief", "Telling a worker something"): the brief (the harness
// template with the line's Goal, Done when, Scope, Limit…, then the package, then the kit's worker rules), the package
// file, and the findings file a failed gate sends back. Composed on the server from the database only; the runner writes
// them under the worktree's `.factory/` (prepare's `files`, `hc send`'s `files`).
import { readFileSync } from 'node:fs';
import type { Ctx } from '../context.ts';
import { json } from '../db.ts';
import { promptStore } from '../routes/prompts.ts';
import { parseTemplate, renderTemplate, type Values } from '../../shared/harness.ts';
import { fill, type ResolvedLine } from '../../shared/line.ts';
import type { FindingInput, ModelRole, StepFile } from '../../shared/factory.ts';
import { localIdOf, projectConfig, type ProjectRow } from './projects.ts';
import { taskVars, updateTask, type TaskRow } from './tasks.ts';

const KIT = new URL('../../shared/kit/', import.meta.url);
const kitCache = new Map<string, string>();
/** A prompt text of the kit (`shared/kit/<name>`), read once. */
export function kitText(name: 'worker.md' | 'foreman.md' | 'planner.md'): string {
  let t = kitCache.get(name);
  if (t === undefined) {
    t = readFileSync(new URL(name, KIT), 'utf8');
    kitCache.set(name, t);
  }
  return t;
}

/** Fills `{name}` placeholders of a kit text; unknown ones stay as they are. */
export const fillKit = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(v, k) ? v[k] : m));

/** The model of a role: the project's override (null = off), else the line's, else the kit default. */
export function modelFor(p: ProjectRow, line: Pick<ResolvedLine, 'models'> | null, role: ModelRole): string | null {
  const o = projectConfig(p).models?.[role];
  if (o !== undefined) return o;
  const l = line?.models?.[role];
  return l === undefined ? (role === 'visual' ? 'sonnet' : 'opus') : l;
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The package's values for templates: §12.2 placeholders, its branch from the line's template. */
function varsOf(t: TaskRow, p: ProjectRow, line: ResolvedLine) {
  const v = taskVars(t, p);
  return { ...v, branch: fill(line.branch, v) };
}

function resourcesText(t: TaskRow): string {
  const parts = [
    t.res_port != null ? `port ${t.res_port}` : null,
    t.res_db ? `database ${code(t.res_db)}` : null,
    t.res_mig_from != null && t.res_mig_to != null ? `migration numbers ${t.res_mig_from}–${t.res_mig_to}` : null,
  ].filter((x): x is string => !!x);
  return parts.length ? list(parts) : 'none were allocated (the line has no `resources`)';
}

/** The acceptance folder of this package, e.g. `tests/acceptance/P1`. */
export const acceptanceDirOf = (t: TaskRow, p: ProjectRow, line: ResolvedLine) => fill(line.paths.acceptance, varsOf(t, p, line)).replace(/\/+$/, '');

/** The line's checks for this package, as the worker runs them. */
function checks(t: TaskRow, p: ProjectRow, line: ResolvedLine): string[] {
  const v = varsOf(t, p, line);
  return [line.enabled.G1 && line.commands.verify, line.enabled.G2 && line.commands.acceptance].filter((c): c is string => !!c).map((c) => fill(c, v));
}

/** The package as Markdown: `.factory/package.md` and the middle of the brief. */
export function packageMarkdown(t: TaskRow, p: ProjectRow): string {
  const crit = (json<string[]>(t.acceptance_json, []) ?? []).map((c, i) => `${i + 1}. ${c}`).join('\n');
  return [
    `# ${t.id}: ${t.title}`,
    '',
    `Package ${code(localIdOf(t.id, p.id_prefix))} of project ${code(p.key)}.`,
    '',
    t.body.trim() || '(no description)',
    '',
    '## Acceptance criteria',
    '',
    crit || '(none given)',
    '',
    '## Resources',
    '',
    `Yours alone: ${resourcesText(t)}.`,
    ...(t.sensitive ? ['', 'This package is **sensitive** (authentication, permissions, personal data or external effects): the owner may be asked before it is integrated.'] : []),
    '',
  ].join('\n');
}

/** The kit's worker rules (`shared/kit/worker.md`) filled for this package. */
export function workerRules(t: TaskRow, p: ProjectRow, line: ResolvedLine): string {
  const v = varsOf(t, p, line);
  const acc = acceptanceDirOf(t, p, line);
  const cmds = checks(t, p, line);
  const prot = [acc, ...line.paths.protected.map((x) => fill(x, v))].filter(Boolean);
  const acceptanceRule = line.qa
    ? `QA wrote black-box acceptance tests for this package in ${code(acc)} before you started (git tag ${code(`bb-acceptance/${t.id}`)}). Make them pass. Never change, delete or skip them, and never touch another package's acceptance tests: G2 fails when they differ from the tag.`
    : line.enabled.G2
      ? `The acceptance tests in ${code(acc)} belong to the owner: make them pass and never change them, nor another package's.`
      : 'This line has no acceptance-test gate: prove each acceptance criterion with tests of your own.';
  return fillKit(kitText('worker.md'), {
    id: t.id,
    project: p.key,
    context: line.context.length ? line.context.map(code).join(', ') : 'none listed',
    acceptanceRule,
    protected: prot.length ? ` or the protected paths ${list(prot.map(code))}` : '',
    resources: resourcesText(t),
    branch: v.branch,
    base: line.base,
    checks: cmds.length ? `${list(cmds.map(code))}.` : 'the project\'s own checks (this line has no verify command).',
  }).trim();
}

/** The harness slots of the brief: Goal, Done when, Scope, Limit, Subagents, Branch, PR, Unattended from the line. */
function briefSlots(t: TaskRow, p: ProjectRow, line: ResolvedLine): Values {
  const acc = acceptanceDirOf(t, p, line);
  const cmds = checks(t, p, line);
  const readOnly = [line.file, ...(line.enabled.G2 ? [acc] : []), ...line.paths.protected];
  return {
    Goal: `Build package ${t.id} (${t.title.replace(/\s+/g, ' ')}) as specified in \`.factory/package.md\`, so that every acceptance criterion holds.`,
    'Done when': [...cmds.map((c) => `\`${c}\` passes`), 'every acceptance criterion in `.factory/package.md` holds', 'your final message ends with `FACTORY-STATUS: done`'].join('\n'),
    Scope: `this worktree, on its own branch; read-only: ${readOnly.map(code).join(', ')}`,
    Limit: `${line.worker.limitHours} hours`,
    Subagents: String(line.worker.subagents),
    Branch: 'current',
    PR: 'no',
    Unattended: 'yes',
  };
}

/** The brief's title in the prompt library. */
const briefTitle = (t: TaskRow) => `Worker brief: ${t.id} ${t.title}`.slice(0, 200);
const BRIEF_TAG = 'factory-brief';

/**
 * The worker's brief, saved in the prompt library with the package recorded on it (§11.1 prompts_save semantics: a new
 * prompt, or a new version of the package's brief). Returns the rendered text.
 */
export function saveBrief(ctx: Ctx, t: TaskRow, p: ProjectRow, line: ResolvedLine, actor: string): { promptId: number | null; version: number; text: string } {
  const store = promptStore(ctx);
  const slots = briefSlots(t, p, line);
  const extraMd = `${packageMarkdown(t, p)}\n${workerRules(t, p, line)}\n`;
  const tpl = store.template({});
  if (!tpl) {
    // no harness template at all: the brief is the package and the rules
    return { promptId: null, version: 0, text: `# Task\n\nGoal: ${slots.Goal}\n\n## Spec\n\n${extraMd}` };
  }
  const cur = t.prompt_id != null ? store.load(t.prompt_id) : null;
  const saved = cur && cur.tags.includes(BRIEF_TAG)
    ? store.update(cur, { title: briefTitle(t), slots, extraMd, templateId: tpl.id })
    : store.load(store.create(tpl.id, briefTitle(t), slots, extraMd, [BRIEF_TAG, p.key]));
  if (!saved) return { promptId: null, version: 0, text: renderTemplate(parseTemplate(tpl.body), slots, extraMd) };
  ctx.db.audit(actor, 'prompt_save', String(saved.id), { version: saved.version, taskId: t.id });
  updateTask(ctx, { id: t.id, promptId: saved.id, promptVersion: saved.version }, actor);
  return { promptId: saved.id, version: saved.version, text: saved.rendered };
}

/** prepare's files: `.factory/brief.md` and `.factory/package.md`. */
export function briefFiles(ctx: Ctx, t: TaskRow, p: ProjectRow, line: ResolvedLine, actor: string): StepFile[] {
  const brief = saveBrief(ctx, t, p, line, actor);
  return [
    { path: 'brief.md', content: brief.text },
    { path: 'package.md', content: packageMarkdown(t, p) },
  ];
}

/** The one line that launches a worker: everything else is in the brief. */
export const LAUNCH_LINE = (id: string) => `Read .factory/brief.md and follow it: it is your task, package ${id} of the Buildyboy factory.`;
/** A worker started again after its session ended without `done`. */
export const RESUME_LINE = (id: string) =>
  `Read .factory/brief.md (your task, package ${id}) and PROGRESS.md if it exists: the previous worker session ended before it finished. Resume from where it stopped.`;

/** A failed gate, back to the worker: one Markdown file for `.factory/inbox/` and the line that points at it. */
export function findingsMessage(
  t: TaskRow, gate: string, round: number, maxRounds: number, summary: string, findings: FindingInput[], line: ResolvedLine, p: ProjectRow,
): { file: StepFile; line: string; text: string } {
  const must = findings.filter((f) => f.severity !== 'minor');
  const minors = findings.filter((f) => f.severity === 'minor');
  const where = (f: FindingInput) => (f.file ? `${code(`${f.file}${f.line != null ? `:${f.line}` : ''}`)}` : 'not given');
  const cmds = checks(t, p, line);
  const out = [
    `# ${gate} failed: round ${round} of ${maxRounds}`,
    '',
    `Package ${t.id}. Fix what is listed below, run the checks again${cmds.length ? ` (${cmds.map(code).join(', ')})` : ''}, commit and push, then end your final message with \`FACTORY-STATUS: done\`. If you think a finding is wrong, say so in your final message, with the reason.`,
    '',
    '## What the gate said',
    '',
    summary.trim().slice(0, 8000) || '(no summary)',
  ];
  if (must.length) {
    out.push('', `## Must fix (${must.length})`);
    must.forEach((f, i) => {
      out.push('', `### ${i + 1}. [${f.severity}] ${f.title}`, '', `- Where: ${where(f)}`);
      if (f.detail) out.push(`- What happens: ${f.detail.trim().slice(0, 4000).replace(/\n+/g, ' ')}`);
      if (f.fix) out.push(`- Fix: ${f.fix.trim().slice(0, 4000).replace(/\n+/g, ' ')}`);
    });
  }
  if (minors.length) {
    out.push('', `## Optional (${minors.length} minor)`, '');
    for (const f of minors) out.push(`- ${f.title} (${where(f)})${f.detail ? `: ${f.detail.trim().slice(0, 500).replace(/\n+/g, ' ')}` : ''}`);
  }
  const name = `inbox/${gate}-round-${round}.md`;
  return {
    file: { path: name, content: `${out.join('\n')}\n` },
    line: `Read .factory/${name}: ${gate} failed in round ${round}. Fix what it lists, run the checks, push, and end with the FACTORY-STATUS line.`,
    text: out.join('\n'),
  };
}

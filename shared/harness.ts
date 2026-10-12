// Prompt factory core: parses a prompt template into slots, renders filled slots back into the
// template, and lints the result. Pure TS, no dependencies, safe for both server and web.
//
// Two template modes:
//  - 'harness': the `Key: <hint>` lines under the `# Task` heading are the slots (harness-prompt.md).
//  - 'generic': no such block, so every `<...>` placeholder anywhere becomes a textarea slot.
// The template body is never rewritten. A parsed template keeps the verbatim body plus the character
// spans of each slot, and rendering splices values into those spans, so everything else (including
// CRLF/LF line endings) stays byte-identical.

export type SlotKind = 'textarea' | 'list' | 'toggle' | 'choice' | 'number';

export interface Slot {
  /** harness: the line key (`Goal`); generic: the placeholder text. Also the key in `values`. */
  key: string;
  /** text between `<` and `>` of the first occurrence */
  hint: string;
  kind: SlotKind;
  /** first sentence of the hint after a dash, shown as help text */
  help?: string;
  /** toggle: ['yes','no']; choice: e.g. ['new','current'] */
  choices?: string[];
  /** choice: the option that takes a name (`new`), with an example name */
  nameFor?: string;
  nameExample?: string;
  /** number: default taken from "default N" in the hint */
  default?: string;
  /** Goal: render as a large textarea */
  large?: boolean;
}

export interface Span {
  slot: string;
  /** offsets into `body` of the `<hint>` being replaced (angle brackets included) */
  start: number;
  end: number;
  /** harness only: offset of the line start, used by the preview to restyle `Key:` */
  head?: number;
}

export interface ParsedTemplate {
  /** the template exactly as read (with its own line endings) */
  body: string;
  eol: '\r\n' | '\n';
  mode: 'harness' | 'generic';
  slots: Slot[];
  spans: Span[];
}

/** Slot values by `Slot.key`. Toggles hold 'yes'/'no', lists hold one item per line, a choice with a
 *  name field stores the name under `<key>.name`. */
export type Values = Record<string, string>;

export interface LintWarning {
  id: string;
  slot?: string;
  message: string;
}

const NAME_SUFFIX = '.name';
export const nameKey = (key: string) => key + NAME_SUFFIX;

// ---------- parsing ----------

const SLOT_LINE = /^([A-Za-z][A-Za-z0-9 _-]{0,30}):[ \t]*(<(.*)>)[ \t]*$/;
const DASH = /\s[—–]\s/;

function detectEol(body: string): '\r\n' | '\n' {
  const i = body.indexOf('\n');
  return i > 0 && body[i - 1] === '\r' ? '\r\n' : '\n';
}

function inferSlot(key: string, hint: string): Slot {
  const slot: Slot = { key, hint, kind: 'textarea' };
  const [main, ...rest] = hint.split(DASH);
  const help = rest.join(' - ').trim();
  if (help) slot.help = help;
  const alts = main.split('|').map((a) => a.trim());
  if (/^(yes\s*\|\s*no|no\s*\|\s*yes)$/i.test(main.trim())) {
    slot.kind = 'toggle';
    slot.choices = ['yes', 'no'];
  } else if (alts.length >= 2 && alts.every((a) => /^[a-z][a-z-]{1,11}(\s*,.*)?$/.test(a))) {
    slot.kind = 'choice';
    slot.choices = alts.map((a) => a.split(/[\s,]/)[0]);
    const named = alts.findIndex((a) => /,/.test(a));
    if (named >= 0) {
      slot.nameFor = slot.choices[named];
      const ex = /`([^`]+)`/.exec(alts[named]) ?? /e\.g\.\s*(\S+)/.exec(alts[named]);
      if (ex) slot.nameExample = ex[1];
    }
  } else if (/^done(\s+when)?$/i.test(key)) {
    slot.kind = 'list';
  } else {
    const d = /\bdefault\s+(\d+(?:\.\d+)?)\b/i.exec(hint);
    if (d) {
      slot.kind = 'number';
      slot.default = d[1];
    }
  }
  if (/^goal$/i.test(key)) slot.large = true;
  return slot;
}

const HTML_TAGS = new Set(['a', 'b', 'i', 'u', 'p', 'br', 'hr', 'em', 'strong', 'code', 'pre', 'div', 'span', 'img', 'ul', 'ol', 'li', 'details', 'summary', 'table', 'tr', 'td', 'th', 'kbd', 'sup', 'sub', 'h1', 'h2', 'h3', 'center', 'blockquote']);

/** True when the text between `<` and `>` is a placeholder rather than an HTML tag, comment or autolink. */
function isPlaceholder(inner: string): boolean {
  const t = inner.trim();
  if (!t || t.startsWith('!') || t.startsWith('?') || /^https?:\/\//i.test(t) || /^\S+@\S+\.\S+$/.test(t)) return false;
  const tag = /^\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[\w:-]+=(?:"[^"]*"|'[^']*'|[^\s"'>]+))*)\s*\/?$/.exec(t);
  if (tag && HTML_TAGS.has(tag[1].toLowerCase())) return false;
  return true;
}

const PLACEHOLDER = /<([^<>\r\n]{1,200})>/g;

function parseHarness(body: string, eol: '\r\n' | '\n'): ParsedTemplate | null {
  const slots: Slot[] = [];
  const spans: Span[] = [];
  let off = 0;
  let inTask = false;
  let started = false;
  for (const line of body.split('\n')) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    const lineStart = off;
    off += line.length + 1;
    if (!inTask) {
      if (/^#\s+Task\s*$/.test(text)) inTask = true;
      continue;
    }
    if (!text.trim()) {
      if (started) break;
      continue;
    }
    const m = SLOT_LINE.exec(text);
    if (!m) break;
    started = true;
    const key = m[1].trim();
    if (slots.some((s) => s.key === key)) continue;
    const start = lineStart + text.indexOf(m[2], key.length);
    slots.push(inferSlot(key, m[3].trim()));
    spans.push({ slot: key, start, end: start + m[2].length, head: lineStart });
  }
  return slots.length ? { body, eol, mode: 'harness', slots, spans } : null;
}

function parseGeneric(body: string, eol: '\r\n' | '\n'): ParsedTemplate {
  const slots: Slot[] = [];
  const spans: Span[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) {
    if (!isPlaceholder(m[1])) continue;
    const key = m[1].trim();
    if (!slots.some((s) => s.key === key)) slots.push({ key, hint: key, kind: 'textarea' });
    spans.push({ slot: key, start: m.index, end: m.index + m[0].length });
  }
  return { body, eol, mode: 'generic', slots, spans };
}

export function parseTemplate(body: string): ParsedTemplate {
  const eol = detectEol(body);
  return parseHarness(body, eol) ?? parseGeneric(body, eol);
}

/** Sensible starting values: number defaults, toggles off, first choice of each choice slot. */
export function defaultValues(p: ParsedTemplate): Values {
  const v: Values = {};
  for (const s of p.slots) {
    if (s.kind === 'toggle') v[s.key] = 'no';
    else if (s.kind === 'choice') v[s.key] = s.choices![0];
    else if (s.kind === 'number') v[s.key] = s.default ?? '';
    else v[s.key] = '';
  }
  return v;
}

// ---------- values ----------

const nl = (s: string) => s.replace(/\r\n?/g, '\n');

/** Items of a list value: one per line, with list markers and blank lines removed. */
export function listItems(value: string | undefined): string[] {
  return nl(value ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

/** Text a slot contributes, with `\n` line breaks (converted to the template's EOL when rendering). */
function slotText(s: Slot, values: Values): string {
  const raw = nl(values[s.key] ?? '').trim();
  switch (s.kind) {
    case 'toggle':
      return /^(yes|no)$/i.test(raw) ? raw.toLowerCase() : '';
    case 'choice': {
      if (!raw) return '';
      const name = (values[nameKey(s.key)] ?? '').trim().replace(/`/g, '');
      return raw === s.nameFor && name ? `${raw}, \`${name}\`` : raw;
    }
    case 'list': {
      // Rule for "Done when": one check renders inline (`Done when: <check>`); several render as a
      // numbered list under the key, each on its own line indented by two spaces:
      //   Done when:
      //     1. first check
      //     2. second check
      const items = listItems(raw);
      if (items.length <= 1) return items[0] ?? '';
      return '\n' + items.map((it, i) => `  ${i + 1}. ${it}`).join('\n');
    }
    default:
      // multi-line text: continuation lines are indented by two spaces so they stay with their key
      return raw
        .split('\n')
        .map((l, i) => (i ? '  ' + l.trimEnd() : l.trimEnd()))
        .join('\n');
  }
}

// ---------- rendering ----------

export interface RenderOptions {
  /** restyle the `Key:` lines as a markdown list so a rendered preview keeps one slot per line */
  preview?: boolean;
}

/** Marker line for a spec file reference, round-trips through `parseSpecRef`. */
export const specRef = (path: string) => `Read the spec at \`${path.trim()}\` in the repository before you start, and follow it.`;
export const parseSpecRef = (md: string): string | null => /^Read the spec at `([^`\n]+)` in the repository before you start, and follow it\.\s*$/.exec(md.trim())?.[1] ?? null;

/**
 * Fills the template. Only the `<hint>` spans change: harness hints are replaced by the slot value (or
 * dropped when empty), generic placeholders are replaced when a value exists and stay as they are
 * otherwise. Extra markdown goes at the end under `## Spec`.
 */
export function renderTemplate(p: ParsedTemplate, values: Values, extraMd?: string, opts: RenderOptions = {}): string {
  const { eol, body } = p;
  const bySlot = new Map(p.slots.map((s) => [s.key, s]));
  let out = '';
  let pos = 0;
  for (const sp of [...p.spans].sort((a, b) => a.start - b.start)) {
    const slot = bySlot.get(sp.slot)!;
    const text = slotText(slot, values);
    out += body.slice(pos, sp.start);
    pos = sp.end;
    if (p.mode === 'generic') {
      out += text ? text.replace(/\n/g, eol) : body.slice(sp.start, sp.end);
      continue;
    }
    if (opts.preview && sp.head !== undefined) {
      const key = out.slice(out.length - (sp.start - sp.head)).replace(/:\s*$/, '');
      out = out.slice(0, out.length - (sp.start - sp.head)) + `- **${key}:** `;
    }
    if (!text || text.startsWith('\n')) out = out.replace(/[ \t]+$/, '');
    out += text.replace(/\n/g, eol);
  }
  out += body.slice(pos);
  const md = nl(extraMd ?? '').trim();
  if (md) {
    if (!out.endsWith('\n')) out += eol;
    out += `${eol}## Spec${eol}${eol}${md.replace(/\n/g, eol)}${eol}`;
  }
  return out;
}

// ---------- lint ----------

const COMMAND = new RegExp(
  '(^|[\\s(])(?:npm|npx|pnpm|yarn|bun|node|deno|tsc|vitest|jest|mocha|playwright|cypress|eslint|prettier|curl|wget|pytest|python3?|pip|poetry|uv|ruff|mypy|make\\s+(?:test|build|check|lint|all|ci|install|verify)|cmake|cargo|rustc|go\\s+(?:test|build|vet|run)|dotnet|mvn|gradle|\\./gradlew|java|javac|bundle|rake|rspec|php|composer|phpunit|docker|kubectl|terraform|git|gh|bash|sh|pwsh|powershell|ls|cat|grep|rg|diff|\\./\\S+)(?=\\s|$|[`),.;])',
  'i',
);

/** True when a check names something runnable: a backticked command, or a recognizable command word. */
export function looksRunnable(check: string): boolean {
  // a backticked phrase like `bin/check --all` counts, a lone path like `/health` does not
  if ([...check.matchAll(/`([^`\n]+)`/g)].some((m) => /\s/.test(m[1].trim()) && !m[1].trim().startsWith('/'))) return true;
  return COMMAND.test(check.replace(/`/g, ' '));
}

const stripCode = (s: string) => s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

/** Placeholders (`<...>` that are not HTML or code) left in a text. */
export function leftoverPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const m of stripCode(text).matchAll(PLACEHOLDER)) if (isPlaceholder(m[1])) found.push(m[0]);
  return [...new Set(found)];
}

const find = (p: ParsedTemplate, re: RegExp, kind?: SlotKind) => p.slots.find((s) => re.test(s.key) && (!kind || s.kind === kind));

/** Warnings from the template's own rules. An empty list means the prompt is ready. */
export function lintPrompt(p: ParsedTemplate, values: Values): LintWarning[] {
  const w: LintWarning[] = [];
  const val = (s: Slot | undefined) => (s ? nl(values[s.key] ?? '').trim() : '');
  const pr = find(p, /^pr$/i);
  const branch = find(p, /^branch$/i);
  const unattended = find(p, /^unattended$/i);
  const limit = find(p, /^limit$/i);
  const done = find(p, /^done(\s+when)?$/i);
  if (pr && val(pr).toLowerCase() === 'yes' && branch && val(branch).toLowerCase() !== 'new') {
    w.push({ id: 'pr-needs-branch', slot: branch.key, message: 'PR: yes needs a new branch. Set Branch to new.' });
  }
  if (unattended && val(unattended).toLowerCase() === 'yes' && limit && !val(limit)) {
    w.push({ id: 'unattended-no-limit', slot: limit.key, message: 'Unattended: yes without a Limit. Add a time or iteration limit so the run ends.' });
  }
  if (done) {
    const items = listItems(values[done.key]);
    if (!items.length) w.push({ id: 'done-empty', slot: done.key, message: 'Done when is empty. Say how the agent can tell it is finished.' });
    else if (!items.some(looksRunnable)) w.push({ id: 'done-no-command', slot: done.key, message: 'Done when has no runnable command. Name a check the agent can run, e.g. `npm test` passes.' });
  }
  for (const s of p.slots.filter((x) => x.kind === 'number')) {
    if (!/^\d+$/.test(val(s))) w.push({ id: 'number-invalid', slot: s.key, message: `${s.key} must be a whole number${/subagent/i.test(s.key) ? ' (0 to work alone)' : ''}.` });
  }
  if (p.mode === 'generic') {
    const empty = p.slots.filter((s) => !val(s));
    if (empty.length) w.push({ id: 'unfilled', message: `${empty.length} placeholder${empty.length === 1 ? '' : 's'} not filled: ${empty.map((s) => `<${s.key}>`).slice(0, 4).join(', ')}${empty.length > 4 ? ', ...' : ''}` });
  } else {
    const left = leftoverPlaceholders(renderTemplate(p, values));
    if (left.length) w.push({ id: 'leftover', message: `Leftover placeholder${left.length === 1 ? '' : 's'} in the prompt: ${left.slice(0, 4).join(', ')}` });
  }
  return w;
}

// ---------- API shapes (server/routes/prompts.ts and the composer) ----------

export interface TemplateInfo {
  id: number;
  name: string;
  /** file path for the seeded harness template, `upload` for pasted ones */
  source: string;
  updatedAt: number;
}

export interface TemplateDetail extends TemplateInfo {
  body: string;
  parsed: ParsedTemplate;
}

export interface PromptStats {
  runs: number;
  /** jobs that ended: succeeded, failed, stopped or lost */
  finished: number;
  succeeded: number;
  successRate: number | null;
  avgCostUsd: number | null;
  avgDurationMs: number | null;
}

export interface PromptView {
  id: number;
  templateId: number | null;
  templateName: string | null;
  title: string;
  slots: Values;
  extraMd: string;
  rendered: string;
  tags: string[];
  version: number;
  createdAt: number;
  updatedAt: number;
  stats: PromptStats;
}

export interface PromptVersion {
  version: number;
  slots: Values;
  extraMd: string;
  rendered: string;
  createdAt: number;
}

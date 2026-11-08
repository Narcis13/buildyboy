// Markdown task files: YAML-like frontmatter plus a body. Generic on purpose (any repo's spec folder works).
//
//   ---
//   id: P2
//   title: Gestiune
//   status: backlog            # optional: backlog | gata | in_lucru | la_porti | integrata | blocata
//   depends_on: [P1]           # or `after:`; a list or a comma-separated string
//   repo: arond
//   branch: pachet/P2
//   priority: 10
//   sensitive: false
//   acceptance:                # optional; otherwise the list under an "Acceptance criteria" heading
//     - Stock moves post to the ledger
//   ---
//   Free text…
//
//   ## Acceptance criteria
//   - …
import { TASK_STATUSES, type TaskStatus } from './factory.ts';

export interface TaskFile {
  id?: string;
  title: string;
  body: string;
  status?: TaskStatus;
  dependsOn: string[];
  repo?: string;
  branch?: string;
  priority?: number;
  sensitive?: boolean;
  acceptance: string[];
}

type Value = string | string[];

function scalar(v: string): string {
  const t = v.trim().replace(/\s+#.*$/, '');
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** Parses `key: value`, `key: [a, b]` and `key:` followed by `- item` lines. Returns null without frontmatter. */
export function parseFrontmatter(text: string): { data: Record<string, Value>; body: string } | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const data: Record<string, Value> = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as string[]).push(scalar(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase().replace(/-/g, '_');
    const raw = kv[2].trim();
    if (!raw) {
      data[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    const arr = /^\[(.*)\]$/.exec(raw);
    data[key] = arr ? arr[1].split(',').map(scalar).filter(Boolean) : scalar(raw);
  }
  return { data, body: text.slice(m[0].length) };
}

const list = (v: Value | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : v.split(',').map((s) => s.trim())).filter(Boolean);
const str = (v: Value | undefined): string | undefined => (typeof v === 'string' && v ? v : Array.isArray(v) && v.length ? v.join(', ') : undefined);

/** Heading text without numbering, trailing colon, emphasis, case or diacritics: "## 5. Criterii de acceptare:" → "criterii de acceptare". */
const headingKey = (h: string) =>
  h.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[*_`]/g, '').replace(/^[\d.)\s]+/, '').replace(/[\s:.]+$/, '').trim();
const EXACT = new Set(['acceptance criteria', 'criterii de acceptare']);
/** Fallback when no heading is exactly one of EXACT: the phrase inside a longer heading ("Acceptance criteria (v2)"). */
const LOOSE = /\b(?:acceptance criteria|criteri(?:i|ile) de accept(?:are|anta))\b/;

/**
 * The list items under the "Acceptance criteria" / "Criterii de acceptare" heading (case and diacritics ignored);
 * without one, under the first heading that contains that phrase. The section runs to the next heading of the same or
 * a higher level. An item continues on its indented lines until the next item, a blank line or a heading.
 */
export function acceptanceSection(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const headings = lines.flatMap((l, i) => {
    const m = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(l);
    return m ? [{ i, level: m[1].length, key: headingKey(m[2]) }] : [];
  });
  const h = headings.find((x) => EXACT.has(x.key)) ?? headings.find((x) => LOOSE.test(x.key));
  if (!h) return [];
  const end = headings.find((x) => x.i > h.i && x.level <= h.level)?.i ?? lines.length;
  const out: string[] = [];
  let open = false; // the previous line belongs to an item, so an indented line continues it
  for (const line of lines.slice(h.i + 1, end)) {
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (item) {
      out.push(item[1].trim());
      open = true;
    } else if (open && /^\s+[^\s#]/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
    else open = false;
  }
  return out;
}

export class TaskFileError extends Error {}

/** One task from one Markdown file. The title falls back to the first `# heading`, then to the file name. */
export function parseTaskFile(text: string, fileName = ''): TaskFile {
  const fm = parseFrontmatter(text);
  if (!fm) throw new TaskFileError(`${fileName || 'file'}: no frontmatter (a block between --- lines at the top)`);
  const d = fm.data;
  const body = fm.body.replace(/^\s*\n/, '');
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = str(d.title) ?? heading ?? fileName.replace(/\.md$/i, '');
  if (!title) throw new TaskFileError(`${fileName || 'file'}: no title`);
  const status = str(d.status);
  if (status && !TASK_STATUSES.includes(status as TaskStatus)) throw new TaskFileError(`${fileName || 'file'}: unknown status "${status}" (use ${TASK_STATUSES.join(', ')})`);
  const priority = str(d.priority);
  if (priority !== undefined && !/^-?\d+$/.test(priority)) throw new TaskFileError(`${fileName || 'file'}: priority must be a whole number`);
  const sensitive = str(d.sensitive);
  const acceptance = list(d.acceptance ?? d.acceptance_criteria ?? d.criterii);
  return {
    id: str(d.id),
    title,
    body,
    status: status as TaskStatus | undefined,
    dependsOn: list(d.depends_on ?? d.after ?? d.dependencies ?? d.dupa),
    repo: str(d.repo),
    branch: str(d.branch),
    priority: priority === undefined ? undefined : Number(priority),
    sensitive: sensitive === undefined ? undefined : /^(true|yes|da|1)$/i.test(sensitive),
    acceptance: acceptance.length ? acceptance : acceptanceSection(body),
  };
}

/** Orders tasks so each one comes after the dependencies defined in the same batch. Throws on a cycle. */
export function orderByDeps<T extends { id?: string; dependsOn: string[] }>(tasks: T[]): T[] {
  const byId = new Map(tasks.filter((t) => t.id).map((t) => [t.id!, t]));
  const out: T[] = [];
  const state = new Map<T, 'visiting' | 'done'>();
  const visit = (t: T) => {
    if (state.get(t) === 'done') return;
    if (state.get(t) === 'visiting') throw new TaskFileError(`dependency cycle through ${t.id}`);
    state.set(t, 'visiting');
    for (const d of t.dependsOn) {
      const dep = byId.get(d);
      if (dep) visit(dep);
    }
    state.set(t, 'done');
    out.push(t);
  };
  tasks.forEach(visit);
  return out;
}

/**
 * tasks_create arguments for one file (always an upsert). Absent lists stay absent, so a re-import never wipes
 * dependencies or criteria added elsewhere; a file without an `id` is matched again by `ref` (its path).
 */
export function taskFileToCreate(t: TaskFile, ref: string) {
  return {
    ...t,
    dependsOn: t.dependsOn.length ? t.dependsOn : undefined,
    acceptance: t.acceptance.length ? t.acceptance : undefined,
    extRef: t.id ? undefined : `md:${ref.split('\\').join('/')}`.slice(0, 300),
    upsert: true,
  };
}

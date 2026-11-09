// The compact timeline's logic: which tool calls fold into groups and the one-line summary of each, plus the
// small parsers shared with the detailed cards. Kept free of React so the vitest suite can import it.
import type { TimelineItem } from '../../../../shared/types.ts';
import { shortPath } from '../../lib/format.ts';

export type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

export function parseJson(s: string | null | undefined): unknown {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function relPath(p: string | null | undefined, cwd: string | null): string {
  if (!p) return '';
  if (cwd && p.toLowerCase().startsWith(cwd.toLowerCase())) return p.slice(cwd.length).replace(/^[\\/]/, '') || p;
  return shortPath(p, 3);
}

export function mcpName(item: ToolItem): { server: string; tool: string } | null {
  if (!item.tool.startsWith('mcp__')) return null;
  const parts = item.tool.split('__');
  return { server: item.mcpServer ?? parts[1] ?? '?', tool: parts.slice(2).join('__') || item.tool };
}

/** Build a diff from Edit-style input when the server had no patch. */
export function patchFromEdits(edits: { old_string?: unknown; new_string?: unknown }[]): string {
  const out: string[] = [];
  for (const e of edits) {
    out.push('@@');
    for (const l of str(e.old_string).split('\n')) out.push(`-${l}`);
    for (const l of str(e.new_string).split('\n')) out.push(`+${l}`);
  }
  return out.join('\n');
}

/** The diff of an Edit / Write / MultiEdit (the server's patch, else rebuilt from the input) and its counts. */
export function editStats(item: ToolItem) {
  const input = asObj(item.input);
  const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input];
  const patch =
    item.patch ??
    (item.tool === 'Write'
      ? str(input.content)
          .replace(/\n$/, '')
          .split('\n')
          .map((l) => `+${l}`)
          .join('\n')
      : patchFromEdits(edits));
  const lines = patch.split('\n');
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  return { patch, added, removed, edits: edits.length };
}

/** "42 lines", "3 files", … for a Read / Grep / Glob result. */
export function searchCounts(item: ToolItem): string[] {
  const out = asObj(parseJson(item.output));
  const counts: string[] = [];
  if (item.tool === 'Read') {
    const file = asObj(out.file);
    const n = Number(file.numLines ?? 0);
    const total = Number(file.totalLines ?? 0);
    if (n) counts.push(total && total !== n ? `${n} of ${total} lines` : plural(n, 'line'));
  } else {
    if (out.numLines != null && item.tool === 'Grep') counts.push(plural(Number(out.numLines), 'matching line'));
    if (out.numFiles != null) counts.push(plural(Number(out.numFiles), 'file'));
  }
  return counts;
}

function oneLine(s: string, max = 140): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Input fields that best say what an MCP call did, in order of preference. */
const MCP_FIELDS = ['url', 'action', 'query', 'command', 'path', 'file_path', 'name', 'title', 'text', 'prompt'];

function tellingField(input: Record<string, unknown>): string {
  for (const k of MCP_FIELDS) if (typeof input[k] === 'string' && input[k]) return str(input[k]);
  const scalar = Object.values(input).find((v) => (typeof v === 'string' && v) || typeof v === 'number');
  return str(scalar);
}

/** One line saying what a tool call did, e.g. `src/app.ts +3 −1` or `Run tests · exit 1`. */
export function toolSummary(item: ToolItem, cwd: string | null): string {
  const input = asObj(item.input);
  const join = (...parts: string[]) => parts.filter(Boolean).join(' · ');
  switch (item.tool) {
    case 'Bash': {
      const exit = item.exitCode != null && item.exitCode !== 0 ? `exit ${item.exitCode}` : '';
      return join(oneLine(str(input.description) || item.command || str(input.command)), exit);
    }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const { added, removed } = editStats(item);
      return `${relPath(item.filePath ?? str(input.file_path || input.notebook_path), cwd)} +${added} −${removed}`;
    }
    case 'Read':
      return join(relPath(item.filePath ?? str(input.file_path), cwd), ...searchCounts(item));
    case 'Grep':
    case 'Glob':
      return join(`${str(input.pattern)}${input.path ? ` in ${relPath(str(input.path), cwd)}` : ''}`, ...searchCounts(item));
    case 'WebFetch':
      return str(input.url);
    case 'WebSearch':
      return oneLine(str(input.query));
    case 'Agent':
    case 'Task':
      return oneLine(str(input.description) || str(input.subagent_type) || 'Subagent');
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      return `${todos.filter((t) => asObj(t).status === 'completed').length}/${todos.length} done`;
    }
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      return oneLine(str(asObj(qs[0]).question));
    }
    case 'ExitPlanMode':
      return oneLine(str(input.plan).replace(/^#+\s*/gm, ''));
    default: {
      const mcp = mcpName(item);
      const field = oneLine(tellingField(input));
      return mcp ? join(`${mcp.server} › ${mcp.tool}`, field) : field;
    }
  }
}

export type Row = { id: string; item: TimelineItem } | { id: string; group: ToolItem[] };

/** Runs shorter than this stay as separate lines: folding two lines into one saves little and hides more. */
const GROUP_MIN = 3;

/** Failures and the calls that waited on the user stay full cards, as in the detailed view. */
export function isStandalone(t: ToolItem): boolean {
  return t.status === 'error' || t.status === 'denied' || t.status === 'blocked' || t.tool === 'AskUserQuestion' || t.tool === 'ExitPlanMode';
}

export function compactRows(items: TimelineItem[]): Row[] {
  const rows: Row[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length >= GROUP_MIN) rows.push({ id: `group-${run[0].id}`, group: run });
    else for (const t of run) rows.push({ id: t.id, item: t });
    run = [];
  };
  for (const i of items) {
    if (i.kind === 'tool' && !isStandalone(i)) run.push(i);
    else {
      flush();
      rows.push({ id: i.id, item: i });
    }
  }
  flush();
  return rows;
}

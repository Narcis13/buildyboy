// One renderer per tool. Anything we don't recognise still shows its input and output as JSON.
import type { ReactNode } from 'react';
import type { TimelineItem } from '../../../../shared/types.ts';
import { duration, shortPath, toolColor } from '../../lib/format.ts';
import { Markdown, RelTime } from '../ui.tsx';
import { asObj, Collapsible, Diff, Json, parseJson, patchFromEdits, Pre, prettyOutput, str } from './parts.tsx';

export type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;
export interface SubagentRef {
  agentId: string;
  agentType: string | null;
  description: string | null;
  status: string | null;
}
export interface TimelineCtx {
  cwd: string | null;
  subagentFor: (item: ToolItem) => SubagentRef | null;
  laneCount: (agentId: string) => number;
  openLane: (agentId: string) => void;
}

export function relPath(p: string | null | undefined, cwd: string | null): string {
  if (!p) return '';
  if (cwd && p.toLowerCase().startsWith(cwd.toLowerCase())) return p.slice(cwd.length).replace(/^[\\/]/, '') || p;
  return shortPath(p, 3);
}

const lineCount = (s: string) => (s ? s.replace(/\n$/, '').split('\n').length : 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function StatusPill({ item }: { item: ToolItem }) {
  if (item.status === 'ok') return null;
  const map: Record<string, [string, string]> = {
    error: ['failed', 'var(--bb-error)'],
    denied: ['denied', 'var(--bb-error)'],
    interrupted: ['interrupted', 'var(--bb-waiting)'],
    running: ['running', 'var(--bb-working)'],
  };
  const [label, color] = map[item.status] ?? [item.status, 'var(--bb-muted)'];
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider ${item.status === 'running' ? 'animate-pulse' : ''}`} style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
      {label}
    </span>
  );
}

function PathLine({ path, cwd }: { path: string | null | undefined; cwd: string | null }) {
  if (!path) return null;
  return (
    <div className="break-all font-mono text-[14px]" title={path}>
      {relPath(path, cwd)}
    </div>
  );
}

function Counts({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[13px] text-muted">{children}</span>;
}

function BashBody({ item }: { item: ToolItem }) {
  const input = asObj(item.input);
  const out = asObj(parseJson(item.output));
  const text = out.stdout !== undefined ? [str(out.stdout), str(out.stderr)].filter(Boolean).join('\n') : str(item.output);
  const n = lineCount(text);
  const failed = item.status === 'error' || (item.exitCode != null && item.exitCode !== 0);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded-lg bg-bg-2 px-2.5 py-1.5 font-mono text-[14px]">
          <span className="select-none text-tool-bash">$ </span>
          {item.command ?? str(input.command)}
        </code>
        {item.exitCode != null && (
          <span data-testid="exit-code" className={`mt-1 shrink-0 rounded px-1.5 py-0.5 font-mono text-[12px] ${failed ? 'bg-error/15 text-error' : 'bg-working/15 text-working'}`}>
            exit {item.exitCode}
          </span>
        )}
      </div>
      {!!input.description && <div className="text-[14px] text-muted">{str(input.description)}</div>}
      {n > 0 && (
        <Collapsible label={`Output · ${plural(n, 'line')}`} open={failed || n <= 6} testId="bash-output">
          <Pre tone={failed ? 'error' : undefined}>{text}</Pre>
        </Collapsible>
      )}
    </div>
  );
}

function EditBody({ item, cwd }: { item: ToolItem; cwd: string | null }) {
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
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <PathLine path={item.filePath ?? str(input.file_path)} cwd={cwd} />
        <Counts>
          <span className="text-working">+{added}</span> <span className="text-error">−{removed}</span>
          {item.tool === 'MultiEdit' ? ` · ${plural(edits.length, 'edit')}` : ''}
        </Counts>
      </div>
      {patch && <Diff patch={patch} />}
      {item.status === 'error' && item.output && <Pre tone="error">{item.output}</Pre>}
    </div>
  );
}

function SearchBody({ item, cwd }: { item: ToolItem; cwd: string | null }) {
  const input = asObj(item.input);
  const out = asObj(parseJson(item.output));
  const file = asObj(out.file);
  const files = Array.isArray(out.filenames) ? (out.filenames as string[]) : [];
  const counts: string[] = [];
  if (item.tool === 'Read') {
    const n = Number(file.numLines ?? 0);
    const total = Number(file.totalLines ?? 0);
    if (n) counts.push(total && total !== n ? `${n} of ${total} lines` : plural(n, 'line'));
  } else {
    if (out.numLines != null && item.tool === 'Grep') counts.push(plural(Number(out.numLines), 'matching line'));
    if (out.numFiles != null) counts.push(plural(Number(out.numFiles), 'file'));
  }
  const content = str(out.content);
  return (
    <div className="flex flex-col gap-1.5">
      {item.tool === 'Read' ? (
        <div className="flex flex-wrap items-center gap-x-3">
          <PathLine path={item.filePath ?? str(input.file_path)} cwd={cwd} />
          {input.offset != null && <Counts>from line {str(input.offset)}</Counts>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all rounded bg-bg-2 px-2 py-0.5 font-mono text-[14px] text-tool-read">{str(input.pattern)}</code>
          {!!input.path && <span className="break-all font-mono text-[13px] text-muted">in {relPath(str(input.path), cwd)}</span>}
          {!!input.glob && <span className="font-mono text-[13px] text-muted">glob {str(input.glob)}</span>}
        </div>
      )}
      {counts.length > 0 && <Counts>{counts.join(' · ')}</Counts>}
      {item.status !== 'ok' && item.output && out.file === undefined && !files.length && <Pre tone={item.status === 'error' ? 'error' : undefined}>{item.output}</Pre>}
      {files.length > 0 && (
        <Collapsible label="Show files">
          <ul className="flex flex-col gap-0.5 font-mono text-[13px]">
            {files.map((f) => (
              <li key={f} className="break-all">
                {relPath(f, cwd)}
              </li>
            ))}
          </ul>
        </Collapsible>
      )}
      {content && (
        <Collapsible label="Matches">
          <Pre>{content}</Pre>
        </Collapsible>
      )}
    </div>
  );
}

function WebBody({ item }: { item: ToolItem }) {
  const input = asObj(item.input);
  const out = asObj(parseJson(item.output));
  if (item.tool === 'WebSearch') {
    const results = Array.isArray(out.results) ? (out.results as Record<string, unknown>[]).filter((r) => r && typeof r === 'object' && r.url) : [];
    return (
      <div className="flex flex-col gap-1.5">
        <div className="text-[15px]">
          <span className="text-muted">Search </span>“{str(input.query)}”
        </div>
        {results.length > 0 && (
          <ul className="flex flex-col gap-1 text-[14px]">
            {results.slice(0, 8).map((r, i) => (
              <li key={i} className="min-w-0">
                <a href={str(r.url)} target="_blank" rel="noreferrer" className="break-all text-accent underline-offset-2 hover:underline">
                  {str(r.title) || str(r.url)}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const url = str(input.url);
  const result = str(out.result) || (item.output && parseJson(item.output) === undefined ? item.output : '');
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <a href={/^https?:/.test(url) ? url : '#'} target="_blank" rel="noreferrer" className="min-w-0 break-all font-mono text-[14px] text-accent underline-offset-2 hover:underline">
          {url}
        </a>
        {out.code != null && <Counts>HTTP {str(out.code)}</Counts>}
      </div>
      {!!input.prompt && <div className="text-[14px] text-muted">{str(input.prompt)}</div>}
      {result && (
        <Collapsible label="Result">
          <Pre>{result}</Pre>
        </Collapsible>
      )}
    </div>
  );
}

function AgentBody({ item, ctx }: { item: ToolItem; ctx: TimelineCtx }) {
  const input = asObj(item.input);
  const out = asObj(parseJson(item.output));
  const content = Array.isArray(out.content) ? (out.content as Record<string, unknown>[]).map((b) => str(b?.text)).join('\n') : str(item.output && parseJson(item.output) === undefined ? item.output : '');
  const sub = ctx.subagentFor(item);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-medium">{str(input.description) || 'Subagent'}</span>
        {!!input.subagent_type && <span className="rounded border border-tool-agent/50 px-1.5 font-mono text-[12px] text-tool-agent">{str(input.subagent_type)}</span>}
      </div>
      {!!input.prompt && (
        <Collapsible label="Prompt">
          <Pre>{str(input.prompt)}</Pre>
        </Collapsible>
      )}
      {content && (
        <div className="rounded-lg border-l-2 border-tool-agent bg-bg-2 px-3 py-2 text-[15px]">
          <Markdown text={content} />
        </div>
      )}
      {sub && (
        <button
          type="button"
          data-testid="open-lane"
          onClick={() => ctx.openLane(sub.agentId)}
          className="inline-flex min-h-11 items-center gap-2 self-start rounded-lg border border-tool-agent/50 px-3 text-[14px] text-tool-agent hover:bg-tool-agent/10"
        >
          ✣ Open subagent lane · {plural(ctx.laneCount(sub.agentId), 'item')}
        </button>
      )}
    </div>
  );
}

const TODO_ICON: Record<string, string> = { completed: '☑', in_progress: '◐', pending: '☐' };

export function TodoList({ todos }: { todos: { content?: unknown; status?: unknown; activeForm?: unknown }[] }) {
  return (
    <ul data-testid="todo-list" className="flex flex-col gap-1">
      {todos.map((t, i) => {
        const st = str(t.status);
        return (
          <li key={i} className={`flex items-start gap-2 text-[15px] ${st === 'completed' ? 'text-muted line-through' : ''}`}>
            <span className={`w-4 shrink-0 text-center ${st === 'in_progress' ? 'text-accent' : st === 'completed' ? 'text-working' : 'text-muted'}`} aria-label={st}>
              {TODO_ICON[st] ?? '☐'}
            </span>
            <span className="min-w-0 break-words">{st === 'in_progress' && t.activeForm ? str(t.activeForm) : str(t.content)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function QuestionBody({ item }: { item: ToolItem }) {
  const input = asObj(item.input);
  const answers = asObj(asObj(parseJson(item.output)).answers);
  const qs = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
  return (
    <div className="flex flex-col gap-3">
      {qs.map((q, i) => {
        const opts = Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : [];
        const answer = str(answers[str(q.question)]);
        return (
          <div key={i} data-testid="question-card" className="rounded-lg border border-line bg-bg-2 p-3">
            {!!q.header && <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">{str(q.header)}</div>}
            <div className="mb-2 text-[15px] font-medium">{str(q.question)}</div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {opts.map((o, j) => {
                const chosen = answer && answer.split(', ').includes(str(o.label));
                return (
                  <div key={j} className={`rounded-md border px-2.5 py-1.5 ${chosen ? 'border-accent bg-accent/10' : 'border-line'}`}>
                    <div className="text-[15px]">
                      {chosen && <span className="mr-1 text-accent">✓</span>}
                      {str(o.label)}
                    </div>
                    {!!o.description && <div className="text-[13px] text-muted">{str(o.description)}</div>}
                  </div>
                );
              })}
            </div>
            {answer && !opts.some((o) => answer.split(', ').includes(str(o.label))) && <div className="mt-2 text-[14px]">Answer: {answer}</div>}
            {!answer && item.status === 'running' && <div className="mt-2 text-[14px] text-waiting">Waiting for an answer</div>}
          </div>
        );
      })}
    </div>
  );
}

function PlanBody({ item }: { item: ToolItem }) {
  const input = asObj(item.input);
  return (
    <div data-testid="plan" className="rounded-lg border border-line bg-bg-2 px-3 py-2 text-[15px]">
      <Markdown text={str(input.plan)} />
    </div>
  );
}

function McpBody({ item }: { item: ToolItem }) {
  const out = prettyOutput(item.output);
  return (
    <div className="flex flex-col gap-1.5">
      <Collapsible label="Input" open>
        <Json value={item.input ?? {}} />
      </Collapsible>
      {out && (
        <Collapsible label="Output" open={out.length < 600}>
          <Pre tone={item.status === 'error' ? 'error' : undefined}>{out}</Pre>
        </Collapsible>
      )}
    </div>
  );
}

function GenericBody({ item }: { item: ToolItem }) {
  const out = prettyOutput(item.output);
  return (
    <div className="flex flex-col gap-1">
      {item.input && Object.keys(item.input).length > 0 && (
        <Collapsible label="Input">
          <Json value={item.input} />
        </Collapsible>
      )}
      {out && (
        <Collapsible label="Output" open={item.status === 'error'}>
          <Pre tone={item.status === 'error' ? 'error' : undefined}>{out}</Pre>
        </Collapsible>
      )}
    </div>
  );
}

function mcpName(item: ToolItem): { server: string; tool: string } | null {
  if (!item.tool.startsWith('mcp__')) return null;
  const parts = item.tool.split('__');
  return { server: item.mcpServer ?? parts[1] ?? '?', tool: parts.slice(2).join('__') || item.tool };
}

function body(item: ToolItem, ctx: TimelineCtx) {
  switch (item.tool) {
    case 'Bash':
      return <BashBody item={item} />;
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return <EditBody item={item} cwd={ctx.cwd} />;
    case 'Read':
    case 'Grep':
    case 'Glob':
      return <SearchBody item={item} cwd={ctx.cwd} />;
    case 'WebFetch':
    case 'WebSearch':
      return <WebBody item={item} />;
    case 'Agent':
    case 'Task':
      return <AgentBody item={item} ctx={ctx} />;
    case 'TodoWrite': {
      const todos = asObj(item.input).todos;
      return Array.isArray(todos) ? <TodoList todos={todos} /> : <GenericBody item={item} />;
    }
    case 'AskUserQuestion':
      return <QuestionBody item={item} />;
    case 'ExitPlanMode':
      return <PlanBody item={item} />;
    default:
      return item.tool.startsWith('mcp__') ? <McpBody item={item} /> : <GenericBody item={item} />;
  }
}

export function ToolCard({ item, ctx }: { item: ToolItem; ctx: TimelineCtx }) {
  const color = toolColor(item.tool);
  const mcp = mcpName(item);
  const bad = item.status === 'error' || item.status === 'denied';
  return (
    <div
      data-testid={`tool-${item.tool}`}
      className={`min-w-0 rounded-xl border bg-panel ${bad ? 'border-error/60' : 'border-line'}`}
      style={{ boxShadow: `inset 3px 0 0 ${color}` }}
    >
      <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5">
        {mcp ? (
          <span className="inline-flex min-w-0 items-center gap-1 truncate rounded px-1.5 py-0.5 font-mono text-[12px]" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
            <span className="opacity-75">mcp</span> {mcp.server} › <b className="font-semibold">{mcp.tool}</b>
          </span>
        ) : (
          <span className="rounded px-1.5 py-0.5 font-mono text-[12px] font-semibold" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
            {item.tool}
          </span>
        )}
        <StatusPill item={item} />
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[12px] text-muted">
          {item.durationMs != null && <span title="Duration">⏱ {duration(item.durationMs)}</span>}
          <RelTime ts={item.ts} />
        </span>
      </div>
      <div className="min-w-0 px-3 pb-2.5 pt-2">{body(item, ctx)}</div>
    </div>
  );
}

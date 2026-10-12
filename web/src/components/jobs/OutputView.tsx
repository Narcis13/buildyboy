// Renders a job's raw stream-json lines readably: assistant text, tool uses, tool results, the result.
// Lines we don't understand are shown raw rather than dropped.
import { useEffect, useMemo, useRef, useState } from 'react';
import { toolColor, usd } from '../../lib/format.ts';
import { Markdown, Toggle } from '../ui.tsx';

export interface OutputLine {
  seq: number;
  ts: number;
  line: string;
}

type Item =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool'; key: string; name: string; summary: string; input: unknown }
  | { kind: 'toolResult'; key: string; text: string; isError: boolean }
  | { kind: 'you'; key: string; text: string }
  | { kind: 'meta'; key: string; text: string }
  | { kind: 'result'; key: string; ok: boolean; text: string; detail: string }
  | { kind: 'stderr'; key: string; text: string }
  | { kind: 'raw'; key: string; text: string };

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function toolSummary(name: string, input: Record<string, unknown>): string {
  return str(input.command) || str(input.file_path) || str(input.path) || str(input.pattern) || str(input.url) || str(input.description) || str(input.prompt).slice(0, 120) || (name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : '');
}

function blockText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : str((b as { text?: unknown })?.text) || (b && typeof b === 'object' && (b as { type?: string }).type === 'image' ? '[image]' : ''))).join('\n');
  return c == null ? '' : JSON.stringify(c);
}

export function toItems(lines: OutputLine[]): Item[] {
  const out: Item[] = [];
  for (const l of lines) {
    const k = String(l.seq);
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(l.line);
    } catch {
      out.push({ kind: 'raw', key: k, text: l.line });
      continue;
    }
    const msg = (m.message ?? {}) as { content?: unknown };
    switch (m.type) {
      case 'assistant': {
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        blocks.forEach((b: Record<string, unknown>, i: number) => {
          const key = `${k}.${i}`;
          if (b.type === 'text') out.push({ kind: 'text', key, text: str(b.text) });
          else if (b.type === 'thinking') out.push({ kind: 'thinking', key, text: str(b.thinking) || '(thinking)' });
          else if (b.type === 'tool_use') out.push({ kind: 'tool', key, name: str(b.name), summary: toolSummary(str(b.name), (b.input ?? {}) as Record<string, unknown>), input: b.input });
          else out.push({ kind: 'raw', key, text: JSON.stringify(b) });
        });
        if (!blocks.length) out.push({ kind: 'raw', key: k, text: l.line });
        break;
      }
      case 'user': {
        if (typeof msg.content === 'string') {
          out.push({ kind: 'you', key: k, text: msg.content });
          break;
        }
        (Array.isArray(msg.content) ? msg.content : []).forEach((b: Record<string, unknown>, i: number) => {
          if (b.type === 'tool_result') out.push({ kind: 'toolResult', key: `${k}.${i}`, text: blockText(b.content), isError: b.is_error === true });
          else if (b.type === 'text') out.push({ kind: 'you', key: `${k}.${i}`, text: str(b.text) });
          else out.push({ kind: 'raw', key: `${k}.${i}`, text: JSON.stringify(b) });
        });
        break;
      }
      case 'buildyboy_user':
        out.push({ kind: 'you', key: k, text: str(m.text) });
        break;
      case 'system': {
        const sub = str(m.subtype);
        if (sub === 'init') out.push({ kind: 'meta', key: k, text: `Session started · ${str(m.model) || 'model ?'} · ${str(m.permissionMode) || str(m.permission_mode) || 'default'} mode` });
        else if (sub.startsWith('hook')) out.push({ kind: 'meta', key: k, text: `hook ${sub.replace('hook_', '')} · ${str(m.hook_event_name) || str(m.hook_name)}` });
        else if (sub === 'api_retry') out.push({ kind: 'meta', key: k, text: `API retry${m.attempt ? ` #${m.attempt}` : ''}${m.error ? ` · ${str(m.error)}` : ''}` });
        else out.push({ kind: 'meta', key: k, text: `system: ${sub || 'event'}` });
        break;
      }
      case 'result': {
        const ok = m.is_error !== true && str(m.subtype) === 'success';
        const detail = [str(m.subtype), typeof m.total_cost_usd === 'number' ? usd(m.total_cost_usd) : '', m.num_turns ? `${m.num_turns} turns` : '', typeof m.duration_ms === 'number' ? `${Math.round(m.duration_ms / 1000)} s` : ''].filter(Boolean).join(' · ');
        out.push({ kind: 'result', key: k, ok, text: str(m.result), detail });
        break;
      }
      case 'stderr':
        out.push({ kind: 'stderr', key: k, text: str(m.text) });
        break;
      case 'stream_event':
        break; // partial deltas; the full message follows
      default:
        out.push({ kind: 'raw', key: k, text: l.line });
    }
  }
  return out;
}

function Collapsible({ text, lines = 8 }: { text: string; lines?: number }) {
  const all = text.split('\n');
  const [open, setOpen] = useState(false);
  const shown = open ? text : all.slice(0, lines).join('\n');
  return (
    <div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-bg-2 p-2 font-mono text-xs text-muted">{shown || '(empty)'}</pre>
      {all.length > lines && (
        <button type="button" className="min-h-9 text-sm text-accent" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show all ${all.length} lines`}
        </button>
      )}
    </div>
  );
}

function ItemView({ it }: { it: Item }) {
  switch (it.kind) {
    case 'text':
      return <Markdown text={it.text} className="text-[15px]" />;
    case 'thinking':
      return <div className="whitespace-pre-wrap text-sm italic text-muted">{it.text}</div>;
    case 'tool':
      return (
        <details className="rounded-lg border border-line bg-panel-2 px-2 py-1">
          <summary className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
            <span className="rounded px-1.5 font-mono text-xs font-semibold text-[#04121f]" style={{ background: toolColor(it.name) }}>
              {it.name}
            </span>
            <span className="truncate font-mono text-xs">{it.summary}</span>
          </summary>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words p-1 font-mono text-xs text-muted">{JSON.stringify(it.input, null, 2)}</pre>
        </details>
      );
    case 'toolResult':
      return (
        <div className={`border-l-2 pl-2 ${it.isError ? 'border-error' : 'border-line'}`}>
          <Collapsible text={it.text} />
        </div>
      );
    case 'you':
      return (
        <div className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-[15px]">
          <span className="mr-2 text-xs font-semibold uppercase tracking-wider text-accent">You</span>
          <span className="whitespace-pre-wrap">{it.text.length > 2000 ? it.text.slice(0, 2000) + '…' : it.text}</span>
        </div>
      );
    case 'meta':
      return <div className="font-mono text-xs text-muted">· {it.text}</div>;
    case 'result':
      return (
        <div className={`rounded-lg border px-3 py-2 ${it.ok ? 'border-working/50' : 'border-error/50'}`}>
          <div className={`text-sm font-semibold ${it.ok ? 'text-working' : 'text-error'}`}>Result · {it.detail}</div>
          {it.text && <Markdown text={it.text} className="mt-1 text-[15px]" />}
        </div>
      );
    case 'stderr':
      return <pre className="whitespace-pre-wrap break-words font-mono text-xs text-error">{it.text}</pre>;
    default:
      return (
        <div className="flex gap-2 font-mono text-xs text-muted">
          <span className="shrink-0 rounded border border-line px-1">raw</span>
          <span className="break-all">{it.text.length > 600 ? it.text.slice(0, 600) + '…' : it.text}</span>
        </div>
      );
  }
}

const PAGE = 400;

export function OutputView({ lines, live }: { lines: OutputLine[]; live: boolean }) {
  const [raw, setRaw] = useState(false);
  const [follow, setFollow] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const items = useMemo(() => toItems(lines), [lines]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow && live) end.current?.scrollIntoView({ block: 'nearest' });
  }, [lines.length, follow, live]);
  const count = raw ? lines.length : items.length;
  const hidden = Math.max(0, count - limit);
  return (
    <section aria-label="Job output" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Output</h2>
        <div className="flex gap-4">
          {live && <Toggle on={follow} onChange={setFollow} label="Follow" />}
          <Toggle on={raw} onChange={setRaw} label="Raw" />
        </div>
      </div>
      {!lines.length && <div className="text-muted">{live ? 'Waiting for output…' : 'No output.'}</div>}
      {hidden > 0 && (
        <button type="button" className="min-h-11 rounded-lg border border-line text-sm text-accent" onClick={() => setLimit(limit + PAGE * 5)}>
          Show {Math.min(hidden, PAGE * 5)} earlier ({hidden} hidden)
        </button>
      )}
      <div className="flex flex-col gap-2" data-testid="job-output">
        {raw
          ? lines.slice(-limit).map((l) => (
              <pre key={l.seq} className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-muted">
                {l.line}
              </pre>
            ))
          : items.slice(-limit).map((it) => <ItemView key={it.key} it={it} />)}
      </div>
      <div ref={end} />
    </section>
  );
}

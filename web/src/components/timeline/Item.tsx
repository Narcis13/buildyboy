// Timeline rows: prompts, Claude's text, thinking, tool calls, events and raw lines.
import { useState } from 'react';
import type { TimelineItem } from '../../../../shared/types.ts';
import { Markdown, RelTime } from '../ui.tsx';
import { Collapsible, Json } from './parts.tsx';
import { ToolCard, type TimelineCtx } from './ToolCard.tsx';

const LEVEL_COLOR = { info: 'var(--bb-idle)', warn: 'var(--bb-waiting)', error: 'var(--bb-error)' } as const;

function EventRow({ item }: { item: Extract<TimelineItem, { kind: 'event' }> }) {
  const [open, setOpen] = useState(false);
  const color = LEVEL_COLOR[item.level] ?? LEVEL_COLOR.info;
  const hasData = item.data != null && typeof item.data === 'object' && Object.keys(item.data as object).length > 0;
  return (
    <div data-testid={`event-${item.event}`} data-level={item.level} className="min-w-0">
      <button
        type="button"
        disabled={!hasData}
        onClick={() => setOpen(!open)}
        aria-expanded={hasData ? open : undefined}
        className={`flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-left ${item.level === 'info' ? 'border-transparent' : ''}`}
        style={item.level === 'info' ? undefined : { borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} 8%, transparent)` }}
      >
        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="shrink-0 font-mono text-[12px] uppercase tracking-wider" style={{ color }}>
          {item.event}
        </span>
        <span className={`min-w-0 flex-1 truncate text-[14px] ${item.level === 'info' ? 'text-muted' : ''}`} title={item.summary}>
          {item.summary}
        </span>
        <RelTime ts={item.ts} className="shrink-0 font-mono text-[12px] text-muted" />
      </button>
      {open && hasData && <Json value={item.data} className="mt-1" />}
    </div>
  );
}

export function ItemView({ item, ctx }: { item: TimelineItem; ctx: TimelineCtx }) {
  switch (item.kind) {
    case 'prompt':
      return (
        <div className="flex justify-end">
          <div className="max-w-[88%] min-w-0 rounded-2xl rounded-br-md border border-accent/40 bg-accent/10 px-3.5 py-2.5">
            <div className="mb-0.5 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-accent">
              {item.agentId ? 'Task prompt' : 'You'} <RelTime ts={item.ts} className="normal-case tracking-normal text-muted" />
            </div>
            <div className="whitespace-pre-wrap break-words text-[15px]">{item.text}</div>
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className="min-w-0 px-1">
          <div className="mb-0.5 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
            Claude <RelTime ts={item.ts} className="normal-case tracking-normal" />
          </div>
          <Markdown text={item.text} className="text-[15px]" />
        </div>
      );
    case 'thinking':
      return (
        <div className="px-1 italic">
          <Collapsible label="Thinking">
            <div className="whitespace-pre-wrap break-words border-l-2 border-line pl-3 text-[14px] text-muted">{item.text}</div>
          </Collapsible>
        </div>
      );
    case 'tool':
      return <ToolCard item={item} ctx={ctx} />;
    case 'event':
      return <EventRow item={item} />;
    case 'raw':
    default: {
      const raw = item as Extract<TimelineItem, { kind: 'raw' }>;
      return (
        <div data-testid="timeline-raw" className="min-w-0 rounded-xl border border-dashed border-line bg-panel/60 px-3 py-2">
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted">raw</span>
            <span className="text-[13px] text-muted">Unrecognised transcript line</span>
            <RelTime ts={raw.ts} className="ml-auto font-mono text-[12px] text-muted" />
          </div>
          <Json value={raw.data ?? item} />
        </div>
      );
    }
  }
}

// Compact timeline: each tool call is one line that opens into its full card, and runs of tool calls with
// nothing between them fold into a single group line.
import { duration, toolColor } from '../../lib/format.ts';
import { StatusPill, ToolCard, type TimelineCtx } from './ToolCard.tsx';
import { mcpName, toolSummary, type ToolItem } from './summary.ts';

const lineCls = 'flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-panel';
const label = (t: ToolItem) => mcpName(t)?.tool ?? t.tool;

function Badge({ tool, children }: { tool: string; children: string }) {
  const color = toolColor(tool);
  return (
    <span className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[12px] font-semibold" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
      {children}
    </span>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <span className={`inline-block w-3 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
      ▸
    </span>
  );
}

export function ToolLine({ item, ctx, open, onToggle }: { item: ToolItem; ctx: TimelineCtx; open: boolean; onToggle: () => void }) {
  if (open) return <ToolCard item={item} ctx={ctx} onCollapse={onToggle} />;
  const summary = toolSummary(item, ctx.cwd);
  return (
    <button type="button" data-testid={`tool-${item.tool}`} data-compact="" aria-expanded={false} onClick={onToggle} className={lineCls} style={{ boxShadow: `inset 3px 0 0 ${toolColor(item.tool)}` }}>
      <Caret open={false} />
      <Badge tool={item.tool}>{item.tool.startsWith('mcp__') ? 'mcp' : item.tool}</Badge>
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={summary}>
        {summary}
      </span>
      <StatusPill item={item} />
      {item.durationMs != null && <span className="shrink-0 font-mono text-[12px] text-muted">{duration(item.durationMs)}</span>}
    </button>
  );
}

export function ToolGroup({ tools, ctx, open, onToggle, isOpen, toggle }: {
  tools: ToolItem[];
  ctx: TimelineCtx;
  open: boolean;
  onToggle: () => void;
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
}) {
  const tally = new Map<string, number>();
  for (const t of tools) tally.set(label(t), (tally.get(label(t)) ?? 0) + 1);
  const mix = [...tally].sort((a, b) => b[1] - a[1]).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
  const failed = tools.filter((t) => (t.status !== 'ok' && t.status !== 'running') || (t.exitCode ?? 0) !== 0).length;
  const running = tools.some((t) => t.status === 'running');
  const total = tools.reduce((n, t) => n + (t.durationMs ?? 0), 0);
  return (
    <div data-testid="tool-group" className="min-w-0">
      <button type="button" aria-expanded={open} onClick={onToggle} className={lineCls} style={{ boxShadow: `inset 3px 0 0 var(--bb-line)` }}>
        <Caret open={open} />
        <span className="shrink-0 font-mono text-[13px] font-semibold">{tools.length} tools</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted" title={mix}>
          {mix}
        </span>
        {failed > 0 && <span className="shrink-0 rounded bg-error/15 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-error">{failed} failed</span>}
        {running && <span className="shrink-0 animate-pulse rounded bg-working/15 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-working">running</span>}
        {total > 0 && <span className="shrink-0 font-mono text-[12px] text-muted">{duration(total)}</span>}
      </button>
      {open && (
        <div className="ml-3 mt-1 flex flex-col gap-1 border-l border-line pl-2">
          {tools.map((t) => (
            <ToolLine key={t.id} item={t} ctx={ctx} open={isOpen(t.id)} onToggle={() => toggle(t.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// Virtualized, chat-like timeline. Sticks to the bottom while live; scrolling up pauses that and shows a pill.
// Compact mode folds tool calls into one-line rows (see Compact.tsx); which rows are open lives here so it
// survives rows scrolling out of the virtualized window.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TimelineItem } from '../../../../shared/types.ts';
import { Empty } from '../ui.tsx';
import { ToolGroup, ToolLine } from './Compact.tsx';
import { compactRows, isStandalone, type Row } from './summary.ts';
import { ItemView } from './Item.tsx';
import type { TimelineCtx } from './ToolCard.tsx';

export function Timeline({ items, ctx, compact = false, hasOlder, loadingOlder, onLoadOlder, empty = 'Nothing here yet.' }: {
  items: TimelineItem[];
  ctx: TimelineCtx;
  compact?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  empty?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [nearTop, setNearTop] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const isOpen = useCallback((id: string) => open.has(id), [open]);
  const toggle = useCallback((id: string) => {
    setOpen((o) => {
      const n = new Set(o);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  }, []);

  const rows = useMemo<Row[]>(() => (compact ? compactRows(items) : items.map((i) => ({ id: i.id, item: i }))), [items, compact]);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => (compact ? 44 : 110),
    overscan: compact ? 12 : 6,
    getItemKey: (i) => rows[i].id,
  });
  const lastRow = rows.length - 1;

  // last scrollTop we set ourselves; anything above it means the reader scrolled up
  const lastPos = useRef(0);
  const toBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastPos.current = el.scrollTop;
  }, []);

  // follow appended items while pinned; otherwise count what arrived
  const lastId = items[items.length - 1]?.id;
  const prevCount = useRef(items.length);
  useLayoutEffect(() => {
    const grew = items.length - prevCount.current;
    prevCount.current = items.length;
    if (!items.length) return;
    if (stick.current) {
      v.scrollToIndex(lastRow, { align: 'end' });
      requestAnimationFrame(toBottom);
    } else if (grew > 0) setUnseen((u) => u + grew);
  }, [lastId]);

  // keep the reading position when older items are prepended
  const firstId = items[0]?.id;
  const anchor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!anchor.current) return;
    const a = anchor.current;
    const idx = rows.findIndex((r) => r.id === a || ('group' in r && r.group.some((t) => t.id === a)));
    anchor.current = null;
    if (idx > 0) v.scrollToIndex(idx, { align: 'start' });
  }, [firstId]);

  // items measured taller after render: stay glued to the bottom
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const sc = ref.current;
      if (!stick.current || !sc) return;
      if (sc.scrollTop < lastPos.current - 4) stick.current = false;
      else toBottom();
    });
    ro.observe(el);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [toBottom]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const b = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    stick.current = b;
    setAtBottom(b);
    setNearTop(el.scrollTop < 400);
    if (b) setUnseen(0);
  };

  const jump = () => {
    stick.current = true;
    setAtBottom(true);
    setUnseen(0);
    v.scrollToIndex(lastRow, { align: 'end' });
    requestAnimationFrame(toBottom);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={onScroll} data-testid="timeline" className="h-full overflow-y-auto overflow-x-hidden overscroll-contain pr-1">
        {!items.length && (
          <div className="p-2">
            <Empty>{empty}</Empty>
          </div>
        )}
        <div ref={inner} style={{ height: v.getTotalSize(), position: 'relative', width: '100%' }}>
          {v.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            const asLine = !('group' in row) && compact && row.item.kind === 'tool' && !isStandalone(row.item);
            const tight = 'group' in row || (asLine && !open.has(row.id));
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={v.measureElement}
                data-testid="timeline-item"
                data-kind={'group' in row ? 'tool-group' : row.item.kind}
                className={`absolute left-0 top-0 w-full ${tight ? 'pb-1' : 'pb-3'}`}
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                {'group' in row ? (
                  <ToolGroup tools={row.group} ctx={ctx} open={open.has(row.id)} onToggle={() => toggle(row.id)} isOpen={isOpen} toggle={toggle} />
                ) : asLine && row.item.kind === 'tool' ? (
                  <ToolLine item={row.item} ctx={ctx} open={open.has(row.id)} onToggle={() => toggle(row.id)} />
                ) : (
                  <ItemView item={row.item} ctx={ctx} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {hasOlder && nearTop && (
        <button
          type="button"
          disabled={loadingOlder}
          onClick={() => {
            anchor.current = items[0]?.id ?? null;
            onLoadOlder?.();
          }}
          className="absolute left-1/2 top-2 z-10 min-h-11 -translate-x-1/2 rounded-full border border-line bg-panel-2 px-4 text-[14px] shadow-lg"
        >
          {loadingOlder ? 'Loading…' : 'Load older'}
        </button>
      )}
      {!atBottom && items.length > 0 && (
        <button
          type="button"
          data-testid="jump-live"
          onClick={jump}
          className="absolute bottom-3 left-1/2 z-10 min-h-11 -translate-x-1/2 rounded-full bg-accent px-4 text-[15px] font-semibold text-accent-ink shadow-lg"
        >
          ↓ Jump to live{unseen ? ` · ${unseen} new` : ''}
        </button>
      )}
    </div>
  );
}

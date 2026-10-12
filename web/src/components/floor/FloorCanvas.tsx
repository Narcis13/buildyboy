// Desktop floor: machines are bays (group nodes), sessions are stations inside them. Pan, zoom, drag;
// positions are remembered per device in localStorage.
import { useCallback, useEffect, useState } from 'react';
import { applyNodeChanges, Background, BackgroundVariant, Controls, Panel, ReactFlow, type Node, type NodeChange, type NodeProps, type OnNodeDrag } from '@xyflow/react';
import type { MachineSummary, SessionSummary } from '../../../../shared/types.ts';
import { navigate } from '../../lib/router.tsx';
import { readStore, useNow, writeStore } from './hooks.ts';
import { STATUS_RANK, Station } from './Station.tsx';

const W = 300;
const H = 232;
const GX = 28;
const GY = 76;
const PAD = 24;
const HEAD = 92;
const BAY_GAP = 64;
const STORE = 'bb-floor-pos-v1';

type Pos = { x: number; y: number };
export interface Bay {
  id: string;
  name: string;
  machine: MachineSummary | null;
  sessions: SessionSummary[];
}

type BayNode = Node<{ bay: Bay }, 'bay'>;
type StationNode = Node<{ s: SessionSummary }, 'station'>;
type FloorNode = BayNode | StationNode;

function BayView({ data, width, height }: NodeProps<BayNode>) {
  const { bay } = data;
  const m = bay.machine;
  const waiting = bay.sessions.filter((s) => s.status === 'waiting').length;
  return (
    <div data-testid={`bay-${bay.id}`} className="relative rounded-2xl border-2 border-dashed border-line bg-bg-2/40" style={{ width, height }}>
      <div className="flex items-center gap-3 px-6 pt-4">
        <span
          title={m?.online ? 'Online' : 'Offline'}
          className="inline-block h-3 w-3 shrink-0 rounded-full"
          style={{ background: m?.online ? 'var(--bb-working)' : 'var(--bb-ended)', boxShadow: m?.online ? '0 0 10px var(--bb-working)' : 'none' }}
        />
        <span className="truncate whitespace-nowrap font-mono text-lg font-semibold uppercase tracking-[0.2em]">{bay.name}</span>
        {waiting ? <span className="ml-auto shrink-0 font-mono text-xs uppercase tracking-wider text-waiting">{waiting} waiting</span> : null}
      </div>
      <div className="flex flex-wrap gap-x-3 whitespace-nowrap px-6 pl-12 font-mono text-[11px] uppercase tracking-wider text-muted">
        <span>{m?.online ? 'online' : 'offline'}</span>
        {m?.platform && <span>{m.platform}</span>}
        <span className={m?.runnerOnline ? 'text-working' : ''}>runner {m?.runnerOnline ? 'online' : 'offline'}</span>
        <span>
          {bay.sessions.length} station{bay.sessions.length === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  );
}

function StationView({ data }: NodeProps<StationNode>) {
  const now = useNow(1000);
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Open session ${data.s.name ?? data.s.id}`}
      className="cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent"
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/s/${data.s.id}`)}
    >
      <Station s={data.s} variant="node" now={now} />
    </div>
  );
}

const nodeTypes = { bay: BayView, station: StationView };

function build(bays: Bay[], stored: Record<string, Pos>, prev: FloorNode[], narrow: boolean): FloorNode[] {
  const prevPos = new Map(prev.map((n) => [n.id, n.position]));
  const out: FloorNode[] = [];
  let x = 0;
  let y = 0;
  for (const bay of bays) {
    const id = `bay:${bay.id}`;
    const list = [...bay.sessions].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.lastEventAt - a.lastEventAt);
    const cols = narrow || list.length <= 1 ? 1 : list.length <= 4 ? 2 : 3;
    const rows = Math.max(1, Math.ceil(list.length / cols));
    let w = PAD * 2 + cols * W + (cols - 1) * GX;
    let h = HEAD + rows * H + (rows - 1) * GY + PAD;
    const children: StationNode[] = list.map((s, i) => {
      const auto = { x: PAD + (i % cols) * (W + GX), y: HEAD + Math.floor(i / cols) * (H + GY) };
      const position = prevPos.get(s.id) ?? stored[s.id] ?? auto;
      w = Math.max(w, position.x + W + PAD);
      h = Math.max(h, position.y + H + PAD);
      return { id: s.id, type: 'station', parentId: id, extent: 'parent', position, data: { s }, width: W, height: H };
    });
    // phones stack bays vertically so the fitted view stays readable
    const position = prevPos.get(id) ?? stored[id] ?? (narrow ? { x: 0, y } : { x, y: 0 });
    out.push({ id, type: 'bay', position, data: { bay }, width: w, height: h, style: { width: w, height: h }, zIndex: 0 }, ...children);
    x = Math.max(x, position.x) + w + BAY_GAP;
    y = Math.max(y, position.y) + h + BAY_GAP;
  }
  return out;
}

export function FloorCanvas({ bays, narrow = false }: { bays: Bay[]; narrow?: boolean }) {
  const [stored, setStored] = useState<Record<string, Pos>>(() => readStore(STORE, {}));
  const [nodes, setNodes] = useState<FloorNode[]>(() => build(bays, stored, [], narrow));

  useEffect(() => {
    setNodes((prev) => {
      const next = build(bays, stored, prev, narrow);
      // keep measured sizes so React Flow doesn't hide nodes while re-measuring
      const measured = new Map(prev.map((n) => [n.id, n.measured]));
      return next.map((n) => (measured.get(n.id) ? { ...n, measured: measured.get(n.id) } : n));
    });
  }, [bays, stored, narrow]);

  const onNodesChange = useCallback((changes: NodeChange<FloorNode>[]) => setNodes((nds) => applyNodeChanges(changes, nds)), []);
  const onNodeDragStop: OnNodeDrag<FloorNode> = useCallback((_e, _node, dragged) => {
    setStored((cur) => {
      const next = { ...cur };
      for (const n of dragged) next[n.id] = n.position;
      writeStore(STORE, next);
      return next;
    });
  }, []);

  const reset = () => {
    writeStore(STORE, {});
    setStored({});
    setNodes(build(bays, {}, [], narrow));
  };

  return (
    <ReactFlow<FloorNode>
      nodes={nodes}
      edges={[]}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={(_e, n) => n.type === 'station' && navigate(`/s/${n.id}`)}
      nodesConnectable={false}
      elementsSelectable={false}
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      minZoom={0.2}
      maxZoom={1.6}
    >
      <style>{'.react-flow__attribution{background:transparent!important}.react-flow__attribution a{color:var(--bb-muted)!important}'}</style>
      <Background variant={BackgroundVariant.Lines} gap={24} color="var(--bb-grid)" />
      <Controls showInteractive={false} />
      <Panel position="top-right">
        <button onClick={reset} className="min-h-11 rounded-lg border border-line bg-panel px-3 text-sm text-muted hover:text-ink">
          Reset layout
        </button>
      </Panel>
    </ReactFlow>
  );
}

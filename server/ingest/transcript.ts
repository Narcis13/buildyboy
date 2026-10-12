// Tolerant parser for Claude Code transcript JSONL. The format is internal and changes, so unknown
// line types are kept as `raw` rather than dropped, and every message keeps its full JSON.

export interface ParsedMessage {
  uuid: string;
  parentUuid: string | null;
  agentId: string | null;
  role: string | null;
  /** prompt | text | thinking | tool_use | tool_result | system | meta | raw */
  kind: string;
  ts: number;
  model: string | null;
  apiMessageId: string | null;
  text: string | null;
  contentJson: string;
  usage: Usage | null;
  isSidechain: boolean;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface SessionPatch {
  name?: string;
  costUsd?: number;
  linesAdded?: number;
  linesRemoved?: number;
  prUrl?: string;
  entrypoint?: string;
  permissionMode?: string;
  compaction?: boolean;
}

export interface ParsedLine {
  message?: ParsedMessage;
  patch?: SessionPatch;
}

/** Line types we understand and deliberately don't show. */
const IGNORED = new Set([
  'attachment', 'queue-operation', 'file-history-snapshot', 'file-history-delta', 'mode', 'atis-latch',
  'last-prompt', 'agent-name', 'relocated', 'progress',
]);

function toTs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

function blockText(content: unknown, type: 'text' | 'thinking'): string {
  if (typeof content === 'string') return type === 'text' ? content : '';
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === type)
    .map((b) => String((b as Record<string, unknown>)[type] ?? ''))
    .join('\n');
}

function firstBlockType(content: unknown): string | null {
  if (typeof content === 'string') return 'text';
  if (Array.isArray(content) && content.length) return String((content[0] as { type?: string })?.type ?? 'raw');
  return null;
}

/** Hash-free stable id for lines without a uuid. */
function syntheticId(line: string): string {
  let h = 2166136261;
  for (let i = 0; i < line.length; i++) h = Math.imul(h ^ line.charCodeAt(i), 16777619);
  return `raw-${(h >>> 0).toString(16)}-${line.length}`;
}

export function parseTranscriptLine(line: string, agentId: string | null = null): ParsedLine {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return {
      message: { uuid: syntheticId(line), parentUuid: null, agentId, role: null, kind: 'raw', ts: Date.now(), model: null, apiMessageId: null, text: null, contentJson: JSON.stringify({ unparsed: line.slice(0, 4096) }), usage: null, isSidechain: false },
    };
  }
  if (!o || typeof o !== 'object') return {};
  const type = String(o.type ?? '');
  const ts = toTs(o.timestamp);
  const base = {
    uuid: typeof o.uuid === 'string' ? o.uuid : syntheticId(line),
    parentUuid: typeof o.parentUuid === 'string' ? o.parentUuid : null,
    agentId: (typeof o.agentId === 'string' ? o.agentId : null) ?? agentId,
    ts,
    isSidechain: o.isSidechain === true,
    contentJson: line,
  };
  const patch: SessionPatch = {};
  if (typeof o.entrypoint === 'string') patch.entrypoint = o.entrypoint;

  switch (type) {
    case 'user': {
      const msg = (o.message ?? {}) as Record<string, unknown>;
      const content = msg.content;
      const first = firstBlockType(content);
      const kind = o.isMeta ? 'meta' : first === 'tool_result' ? 'tool_result' : 'prompt';
      if (typeof o.permissionMode === 'string') patch.permissionMode = o.permissionMode;
      return { message: { ...base, role: 'user', kind, model: null, apiMessageId: null, text: blockText(content, 'text') || null, usage: null }, patch };
    }
    case 'assistant': {
      const msg = (o.message ?? {}) as Record<string, unknown>;
      const content = msg.content;
      const first = firstBlockType(content) ?? 'text';
      const kind = first === 'thinking' || first === 'redacted_thinking' ? 'thinking' : first === 'tool_use' || first === 'server_tool_use' ? 'tool_use' : first === 'text' ? 'text' : 'raw';
      const text = kind === 'thinking' ? blockText(content, 'thinking') : blockText(content, 'text');
      return {
        message: {
          ...base,
          role: 'assistant',
          kind,
          model: typeof msg.model === 'string' ? msg.model : null,
          apiMessageId: typeof msg.id === 'string' ? msg.id : null,
          text: text || null,
          usage: (msg.usage as Usage) ?? null,
        },
        patch,
      };
    }
    case 'system': {
      const subtype = String(o.subtype ?? '');
      if (subtype === 'compact_boundary') patch.compaction = true;
      if (subtype === 'turn_duration' || subtype === 'stop_hook_summary') return { patch };
      return { message: { ...base, role: 'system', kind: 'system', model: null, apiMessageId: null, text: typeof o.content === 'string' ? o.content : subtype, usage: null }, patch };
    }
    case 'summary':
      return { patch: typeof o.summary === 'string' ? { name: o.summary } : {} };
    case 'ai-title':
      return { patch: typeof o.aiTitle === 'string' ? { name: o.aiTitle } : {} };
    case 'custom-title':
      return { patch: typeof o.customTitle === 'string' ? { name: o.customTitle } : {} };
    case 'cost-state':
      return {
        patch: {
          costUsd: typeof o.totalCostUSD === 'number' ? o.totalCostUSD : undefined,
          linesAdded: typeof o.totalLinesAdded === 'number' ? o.totalLinesAdded : undefined,
          linesRemoved: typeof o.totalLinesRemoved === 'number' ? o.totalLinesRemoved : undefined,
        },
      };
    case 'pr-link':
      return { patch: typeof o.prUrl === 'string' ? { prUrl: o.prUrl } : {} };
    case 'permission-mode':
      return { patch: typeof o.permissionMode === 'string' ? { permissionMode: o.permissionMode } : {} };
    default:
      if (IGNORED.has(type)) return { patch };
      return { message: { ...base, role: null, kind: 'raw', model: null, apiMessageId: null, text: null, usage: null }, patch };
  }
}

/** Splits a chunk into complete JSONL lines, dropping blanks. */
export function splitLines(chunk: string): string[] {
  return chunk.split(/\r?\n/).filter((l) => l.trim() !== '');
}

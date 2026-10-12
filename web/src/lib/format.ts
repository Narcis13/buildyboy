export function relTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const s = Math.round((now - ts) / 1000);
  if (s < 0) return `in ${duration(-s * 1000)}`;
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function exactTime(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : '';
}

export function usd(n: number | null | undefined): string {
  if (n == null) return '—';
  return n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(0)}`;
}

export function tokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

export function shortPath(p: string | null | undefined, keep = 2): string {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= keep ? p : `…/${parts.slice(-keep).join('/')}`;
}

/** Tool name -> color used by the conveyor belt and the timeline. */
export function toolColor(tool: string): string {
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob' || tool === 'LS') return 'var(--bb-tool-read)';
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'var(--bb-tool-edit)';
  if (tool === 'Bash' || tool === 'BashOutput' || tool === 'KillShell') return 'var(--bb-tool-bash)';
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'var(--bb-tool-web)';
  if (tool.startsWith('mcp__')) return 'var(--bb-tool-mcp)';
  if (tool === 'Agent' || tool === 'Task') return 'var(--bb-tool-agent)';
  return 'var(--bb-tool-other)';
}

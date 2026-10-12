// Small building blocks shared by the timeline renderers.
import { useState, type ReactNode } from 'react';

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

/** MCP tools often return `[{type:'text', text}]`; flatten that to text, else pretty JSON. */
export function prettyOutput(output: string | null): string {
  if (!output) return '';
  const v = parseJson(output);
  if (v === undefined) return output;
  if (Array.isArray(v) && v.every((b) => asObj(b).type === 'text')) {
    return v.map((b) => {
      const t = str(asObj(b).text);
      const inner = parseJson(t);
      return inner !== undefined && inner !== null && typeof inner === 'object' ? JSON.stringify(inner, null, 2) : t;
    }).join('\n');
  }
  return JSON.stringify(v, null, 2);
}

export function Pre({ children, className = '', tone }: { children: ReactNode; className?: string; tone?: 'error' }) {
  return (
    <pre
      className={`max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-bg-2 p-2.5 font-mono text-[13px] leading-relaxed ${tone === 'error' ? 'border-error/50 text-error' : 'border-line'} ${className}`}
    >
      {children}
    </pre>
  );
}

export function Json({ value, className = '' }: { value: unknown; className?: string }) {
  return <Pre className={className}>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</Pre>;
}

/** Toggle with a 44px hit target. */
export function Collapsible({ label, children, open: initial = false, testId }: { label: ReactNode; children: ReactNode; open?: boolean; testId?: string }) {
  const [open, setOpen] = useState(initial);
  return (
    <div>
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="-mx-1 flex min-h-11 items-center gap-1.5 rounded px-1 text-left text-[14px] text-muted hover:text-ink"
      >
        <span className={`inline-block w-3 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
          ▸
        </span>
        {label}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

/** Unified diff, colored by line. Accepts several concatenated file patches. */
export function Diff({ patch, testId = 'diff' }: { patch: string; testId?: string }) {
  const lines = patch.replace(/\n$/, '').split('\n');
  const seen = new Set<string>();
  return (
    <div data-testid={testId} className="max-h-96 overflow-auto rounded-lg border border-line bg-bg-2 font-mono text-[13px] leading-[1.45]">
      {lines.map((l, i) => {
        if (l.startsWith('--- ')) return null;
        if (l.startsWith('+++ ')) {
          if (seen.has(l)) return null;
          seen.add(l);
          return (
            <div key={i} className="sticky top-0 border-b border-line bg-panel-2 px-2.5 py-1 text-[12px] text-muted">
              {l.slice(4).replace(/^b\//, '')}
            </div>
          );
        }
        const kind = l.startsWith('@@') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx';
        const cls = kind === 'add' ? 'text-working' : kind === 'del' ? 'text-error' : kind === 'hunk' ? 'text-accent/80' : 'text-ink/85';
        const bg = kind === 'add' ? 'var(--bb-add-bg)' : kind === 'del' ? 'var(--bb-del-bg)' : undefined;
        return (
          <div key={i} data-line={kind} className={`whitespace-pre-wrap break-all px-2.5 ${cls}`} style={{ background: bg }}>
            {l || ' '}
          </div>
        );
      })}
    </div>
  );
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

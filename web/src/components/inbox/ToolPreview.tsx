import { useMemo, useState } from 'react';
import { diffLines } from '../../../../shared/diff.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 2));

function Code({ children, testId }: { children: string; testId?: string }) {
  return (
    <pre data-testid={testId} className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-bg-2 p-3 font-mono text-sm leading-snug">
      {children}
    </pre>
  );
}

/** Edit-style diff: removed lines red, added lines green. Big inputs are clamped and expandable. */
function Diff({ before, after, path }: { before: string; after: string; path?: string }) {
  const [all, setAll] = useState(false);
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const shown = all ? lines : lines.slice(0, 60);
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg-2">
      {path && <div className="border-b border-line px-3 py-1.5 font-mono text-sm text-muted break-all">{path}</div>}
      <div className="max-h-72 overflow-auto font-mono text-sm leading-snug">
        {shown.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap break-words px-3" style={{ background: l.op === '+' ? 'var(--bb-add-bg)' : l.op === '-' ? 'var(--bb-del-bg)' : undefined }}>
            <span className="mr-2 select-none text-muted">{l.op === ' ' ? ' ' : l.op}</span>
            {l.text}
          </div>
        ))}
      </div>
      {lines.length > 60 && (
        <button className="min-h-[44px] w-full border-t border-line text-sm text-accent" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

/** The full tool input for a permission request, rendered so it can be judged without opening the session. */
export function ToolPreview({ tool, input }: { tool: string | null; input: Record<string, unknown> | undefined }) {
  const [full, setFull] = useState(false);
  if (!input) return null;
  const path = str(input.file_path ?? input.path ?? input.notebook_path);

  if (tool === 'Bash' && typeof input.command === 'string') {
    return (
      <div className="space-y-1.5">
        {typeof input.description === 'string' && input.description && <div className="text-sm text-muted">{input.description}</div>}
        <Code testId="inbox-command">{input.command}</Code>
      </div>
    );
  }
  if (tool === 'Edit' && typeof input.old_string === 'string') {
    return <Diff before={input.old_string} after={str(input.new_string)} path={path} />;
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return (
      <div className="space-y-2">
        {(input.edits as Record<string, unknown>[]).map((e, i) => (
          <Diff key={i} before={str(e.old_string)} after={str(e.new_string)} path={i === 0 ? path : undefined} />
        ))}
      </div>
    );
  }
  if (tool === 'Write' && typeof input.content === 'string') {
    const long = input.content.length > 4000;
    return (
      <div className="space-y-1.5">
        <div className="break-all font-mono text-sm text-muted">{path} <span className="text-working">(new content, {input.content.split('\n').length} lines)</span></div>
        <Code>{long && !full ? `${input.content.slice(0, 4000)}\n…` : input.content}</Code>
        {long && (
          <button className="min-h-[44px] text-sm text-accent" onClick={() => setFull(!full)}>
            {full ? 'Show less' : 'Show everything'}
          </button>
        )}
      </div>
    );
  }
  if ((tool === 'WebFetch' || tool === 'WebSearch') && (input.url || input.query)) {
    return <Code>{str(input.url ?? input.query) + (input.prompt ? `\n\n${str(input.prompt)}` : '')}</Code>;
  }
  return <Code>{JSON.stringify(input, null, 2)}</Code>;
}

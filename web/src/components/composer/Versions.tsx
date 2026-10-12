// Version history of a saved prompt, with a unified diff between any two versions.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PromptVersion } from '../../../../shared/harness.ts';
import { diffLines, diffStats, unifiedDiff } from '../../../../shared/diff.ts';
import { api } from '../../lib/api.ts';
import { exactTime } from '../../lib/format.ts';
import { Button, inputCls, labelCls } from './fields.tsx';

export function Versions({ promptId, onRestore }: { promptId: number; onRestore?: (v: PromptVersion) => void }) {
  const q = useQuery({ queryKey: ['prompt-versions', promptId], queryFn: () => api.get<PromptVersion[]>(`/api/prompts/${promptId}/versions`) });
  const versions = q.data ?? [];
  const [pick, setPick] = useState<{ from?: number; to?: number }>({});
  const to = pick.to ?? versions[0]?.version;
  const from = pick.from ?? (to !== undefined ? versions.find((v) => v.version < to)?.version ?? to : undefined);
  const a = versions.find((v) => v.version === from);
  const b = versions.find((v) => v.version === to);
  const diff = useMemo(() => (a && b ? { text: unifiedDiff(a.rendered, b.rendered, 'TASK.md'), stats: diffStats(diffLines(a.rendered, b.rendered)) } : null), [a, b]);

  if (q.isLoading) return <p className="text-[15px] text-muted">Loading versions…</p>;
  if (!versions.length) return <p className="text-[15px] text-muted">No versions yet.</p>;
  const opts = versions.map((v) => (
    <option key={v.version} value={v.version}>
      v{v.version} · {exactTime(v.createdAt)}
    </option>
  ));
  return (
    <div data-testid="versions" className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls} htmlFor={`vf-${promptId}`}>
            From
          </label>
          <select id={`vf-${promptId}`} className={inputCls} value={from} onChange={(e) => setPick({ from: Number(e.target.value), to })}>
            {opts}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor={`vt-${promptId}`}>
            To
          </label>
          <select id={`vt-${promptId}`} className={inputCls} value={to} onChange={(e) => setPick({ from, to: Number(e.target.value) })}>
            {opts}
          </select>
        </div>
      </div>
      {diff && (
        <>
          <p className="text-[15px] text-muted">
            v{from} to v{to}: <span className="text-working">+{diff.stats.added}</span> <span className="text-error">-{diff.stats.removed}</span>
          </p>
          <pre data-testid="version-diff" className="max-h-96 overflow-auto rounded-lg border border-line bg-bg-2 p-2 font-mono text-[15px]">
            {diff.stats.added + diff.stats.removed === 0
              ? 'No differences.'
              : diff.text.split('\n').map((l, i) => (
                  <div
                    key={i}
                    className={`whitespace-pre-wrap break-words ${l.startsWith('@@') ? 'text-muted' : ''}`}
                    style={l.startsWith('+') && !l.startsWith('+++') ? { background: 'var(--bb-add-bg)' } : l.startsWith('-') && !l.startsWith('---') ? { background: 'var(--bb-del-bg)' } : undefined}
                  >
                    {l || ' '}
                  </div>
                ))}
          </pre>
        </>
      )}
      {onRestore && b && <Button onClick={() => onRestore(b)}>Load v{b.version} into the editor</Button>}
    </div>
  );
}

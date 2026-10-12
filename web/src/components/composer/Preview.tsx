// Live preview of the rendered prompt (markdown or raw) with the lint summary.
import { useState } from 'react';
import type { LintWarning } from '../../../../shared/harness.ts';
import { Markdown, Tabs } from '../ui.tsx';
import { tabsTap } from './fields.tsx';

interface Props {
  /** markdown restyled for reading (slot lines as a list) */
  markdown: string;
  /** exactly what gets copied / downloaded */
  raw: string;
  warnings: LintWarning[];
}

export function Preview({ markdown, raw, warnings }: Props) {
  const [view, setView] = useState<'preview' | 'raw'>('preview');
  return (
    <div>
      <div data-testid="lint-summary" className={warnings.length ? 'mb-3 rounded-lg border border-waiting/60 bg-waiting/10 p-3' : 'sr-only'} aria-live="polite">
        {warnings.length > 0 && (
          <>
            <p className="mb-1 font-semibold text-waiting">
              {warnings.length} warning{warnings.length === 1 ? '' : 's'}
            </p>
            <ul className="space-y-1 text-[15px]">
              {warnings.map((w) => (
                <li key={w.id}>⚠ {w.message}</li>
              ))}
            </ul>
          </>
        )}
      </div>
      <Tabs
        tabs={[
          { id: 'preview' as const, label: 'Rendered' },
          { id: 'raw' as const, label: 'Raw Markdown' },
        ]}
        value={view}
        onChange={setView}
        className={`mb-3 ${tabsTap}`}
      />
      {view === 'preview' ? (
        <div data-testid="preview" className="max-h-[70vh] overflow-auto rounded-lg border border-line bg-bg-2 p-3 text-[15px]">
          <Markdown text={markdown} />
        </div>
      ) : (
        <pre data-testid="raw-preview" className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-bg-2 p-3 font-mono text-[15px]">
          {raw}
        </pre>
      )}
    </div>
  );
}

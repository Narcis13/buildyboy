// Attach spec: free markdown appended as "## Spec", or a pointer to a spec file in the target repo.
import { useState } from 'react';
import { specRef } from '../../../../shared/harness.ts';
import { Tabs } from '../ui.tsx';
import { errorText, helpCls, inputCls, labelCls, tabsTap } from './fields.tsx';

export type SpecMode = 'md' | 'file';

/** The extraMd string a spec state produces. */
export const specToExtra = (mode: SpecMode, md: string, file: string) => (mode === 'file' ? (file.trim() ? specRef(file) : '') : md);

interface Props {
  mode: SpecMode;
  md: string;
  file: string;
  onMode: (m: SpecMode) => void;
  onMd: (v: string) => void;
  onFile: (v: string) => void;
}

export function SpecAttach({ mode, md, file, onMode, onMd, onFile }: Props) {
  const [err, setErr] = useState('');
  return (
    <div>
      <Tabs
        tabs={[
          { id: 'md' as const, label: 'Paste markdown' },
          { id: 'file' as const, label: 'File in the repo' },
        ]}
        value={mode}
        onChange={onMode}
        className={`mb-3 ${tabsTap}`}
      />
      {mode === 'md' ? (
        <div>
          <label htmlFor="spec-md" className={labelCls}>
            Spec markdown
          </label>
          <textarea id="spec-md" rows={6} className={`${inputCls} resize-y font-mono`} value={md} placeholder="Appended to the prompt as a ## Spec section" onChange={(e) => onMd(e.target.value)} />
          <label className="mt-2 inline-flex min-h-[44px] cursor-pointer items-center rounded-lg border border-line bg-panel-2 px-4 text-[15px] hover:border-accent">
            Load from a .md file
            <input
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                try {
                  onMd(await f.text());
                  setErr('');
                } catch (x) {
                  setErr(errorText(x));
                }
              }}
            />
          </label>
          {err && <p className="mt-1 text-[15px] text-error">{err}</p>}
        </div>
      ) : (
        <div>
          <label htmlFor="spec-file" className={labelCls}>
            Spec file path
          </label>
          <input id="spec-file" className={`${inputCls} font-mono`} value={file} placeholder="docs/spec.md" onChange={(e) => onFile(e.target.value)} />
          <p className={helpCls}>The prompt only gets one line that tells Claude to read this file, relative to the project directory.</p>
        </div>
      )}
    </div>
  );
}

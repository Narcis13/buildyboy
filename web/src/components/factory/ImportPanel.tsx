import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.ts';
import { Button, Card } from '../ui.tsx';
import { Field, inputClass } from '../settings/bits.tsx';

const EXAMPLE = `---
id: P2
title: Stock movements
depends_on: [P1]
status: gata
priority: 10
sensitive: false
acceptance:
  - Stock moves post to the ledger
---
Free text describing the package.`;

interface Imported {
  imported: string[];
}

function readFile(f: File): Promise<{ name: string; text: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: f.name, text: String(r.result ?? '') });
    r.onerror = () => reject(r.error ?? new Error(`could not read ${f.name}`));
    r.readAsText(f);
  });
}

/** Bring packages in from Markdown files (or pasted Markdown) and from GitHub issues. */
export function ImportPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [pasted, setPasted] = useState('');
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [label, setLabel] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const ok = (r: Imported) => {
    setDone(r.imported.length ? `Imported ${r.imported.join(', ')}` : 'Nothing to import');
    qc.invalidateQueries({ queryKey: ['tasks'] });
  };
  const md = useMutation({
    mutationFn: async () => {
      const read = await Promise.all(files.map(readFile));
      if (pasted.trim()) read.push({ name: 'pasted.md', text: pasted });
      return api.post<Imported>('/api/tasks/import/markdown', { files: read });
    },
    onMutate: () => setDone(null),
    onSuccess: (r) => {
      ok(r);
      setFiles([]);
      setPasted('');
      if (fileRef.current) fileRef.current.value = '';
    },
  });
  const gh = useMutation({
    mutationFn: () => api.post<Imported>('/api/tasks/import/github', { owner: owner.trim(), repo: repo.trim(), ...(label.trim() ? { label: label.trim() } : {}) }),
    onMutate: () => setDone(null),
    onSuccess: ok,
  });

  return (
    <Card className="mb-4 p-4" data-testid="import-panel">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold tracking-wide">Import</h2>
        <Button size="sm" onClick={onClose}>Close</Button>
      </div>
      {done && <div className="mt-2 text-working" role="status" data-testid="import-done">{done}</div>}
      <div className="mt-3 grid gap-6 md:grid-cols-2">
        <div className="min-w-0 space-y-3">
          <h3 className="text-[15px] font-semibold">Markdown</h3>
          <Field label="Markdown files" htmlFor="imp-files" hint="One package per file, with frontmatter. Several files are ordered by their dependencies.">
            <input
              ref={fileRef}
              id="imp-files"
              type="file"
              multiple
              accept=".md,.markdown,text/markdown,text/plain"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              className="block min-h-[44px] w-full rounded-lg border border-line bg-bg-2 p-2 text-[15px] file:mr-3 file:min-h-[36px] file:rounded-md file:border-0 file:bg-panel-2 file:px-3 file:text-ink"
              data-testid="imp-files"
            />
          </Field>
          <Field label="Or paste Markdown" htmlFor="imp-paste">
            <textarea id="imp-paste" rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} className={`${inputClass} py-2 font-mono text-sm`} placeholder={EXAMPLE} data-testid="imp-paste" spellCheck={false} />
          </Field>
          <details className="text-sm text-muted">
            <summary className="flex min-h-[44px] cursor-pointer items-center">Format example</summary>
            <pre className="overflow-x-auto rounded-lg border border-line bg-bg-2 p-3 font-mono text-sm text-ink">{EXAMPLE}</pre>
          </details>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={md.isPending || (!files.length && !pasted.trim())} onClick={() => md.mutate()} data-testid="imp-md-submit">
              {md.isPending ? 'Importing…' : 'Import Markdown'}
            </Button>
            {md.error && <span className="text-error" role="alert">{(md.error as Error).message}</span>}
          </div>
        </div>
        <div className="min-w-0 space-y-3">
          <h3 className="text-[15px] font-semibold">GitHub issues</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Owner" htmlFor="imp-owner">
              <input id="imp-owner" value={owner} onChange={(e) => setOwner(e.target.value)} className={inputClass} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            </Field>
            <Field label="Repo" htmlFor="imp-repo">
              <input id="imp-repo" value={repo} onChange={(e) => setRepo(e.target.value)} className={inputClass} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            </Field>
          </div>
          <Field label="Label (optional)" htmlFor="imp-label" hint="Only issues with this label. Needs a GitHub token in Settings.">
            <input id="imp-label" value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} autoCapitalize="off" spellCheck={false} />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={gh.isPending || !owner.trim() || !repo.trim()} onClick={() => gh.mutate()} data-testid="imp-gh-submit">
              {gh.isPending ? 'Importing…' : 'Import issues'}
            </Button>
            {gh.error && <span className="text-error" role="alert">{(gh.error as Error).message}</span>}
          </div>
        </div>
      </div>
    </Card>
  );
}

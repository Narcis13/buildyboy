// Template picker plus "add a template" (paste or upload). Any <placeholder> in an added template becomes a slot.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TemplateDetail, TemplateInfo } from '../../../../shared/harness.ts';
import { api } from '../../lib/api.ts';
import { shortPath } from '../../lib/format.ts';
import { RelTime } from '../ui.tsx';
import { Button, errorText, helpCls, inputCls, labelCls } from './fields.tsx';

interface Props {
  templates: TemplateInfo[];
  value: number | null;
  onChange: (id: number) => void;
}

export function TemplatePicker({ templates, value, onChange }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const current = templates.find((t) => t.id === value);

  async function add() {
    setBusy(true);
    setErr('');
    try {
      const t = await api.post<TemplateDetail>('/api/templates', { name, body });
      await qc.invalidateQueries({ queryKey: ['templates'] });
      onChange(t.id);
      setOpen(false);
      setName('');
      setBody('');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!current) return;
    try {
      await api.del(`/api/templates/${current.id}`);
      await qc.invalidateQueries({ queryKey: ['templates'] });
      const next = templates.find((t) => t.id !== current.id);
      if (next) onChange(next.id);
    } catch (e) {
      setErr(errorText(e));
    }
  }

  return (
    <div>
      <label htmlFor="tpl-select" className={labelCls}>
        Template
      </label>
      <div className="flex flex-wrap gap-2">
        <select id="tpl-select" className={`${inputCls} min-w-0 flex-1`} value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <Button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Close' : '+ Add template'}
        </Button>
        {current && current.source === 'upload' && <Button onClick={remove}>Remove</Button>}
      </div>
      {current && (
        <p className={helpCls}>
          {current.source === 'upload' ? 'Uploaded template' : shortPath(current.source, 3)} · updated <RelTime ts={current.updatedAt} />
        </p>
      )}
      {open && (
        <div className="mt-3 space-y-2 rounded-lg border border-line bg-panel-2 p-3">
          <label htmlFor="tpl-name" className={labelCls}>
            Template name
          </label>
          <input id="tpl-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="bugfix" />
          <label htmlFor="tpl-body" className={labelCls}>
            Template markdown (every {'<placeholder>'} becomes a field)
          </label>
          <textarea id="tpl-body" rows={7} className={`${inputCls} resize-y font-mono`} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Fix <the bug> in <module>. Done when <check>." />
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex min-h-[44px] cursor-pointer items-center rounded-lg border border-line bg-panel px-4 text-[15px] hover:border-accent">
              Upload a file
              <input
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                className="sr-only"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  setBody(await f.text());
                  if (!name) setName(f.name.replace(/\.\w+$/, ''));
                }}
              />
            </label>
            <Button variant="primary" disabled={busy || !name.trim() || !body.trim()} onClick={add}>
              Add template
            </Button>
          </div>
        </div>
      )}
      {err && (
        <p role="alert" className="mt-2 text-[15px] text-error">
          {err}
        </p>
      )}
    </div>
  );
}

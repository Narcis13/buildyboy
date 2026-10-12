// Prompt factory: fills the harness template (or an uploaded one) into a prompt you can copy, download,
// save to the library or launch as a job. Rendering and linting come from shared/harness.ts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  defaultValues, lintPrompt, parseSpecRef, renderTemplate, type PromptVersion, type PromptView, type TemplateDetail, type TemplateInfo, type Values,
} from '../../../shared/harness.ts';
import { api } from '../lib/api.ts';
import { navigate } from '../lib/router.tsx';
import { PageTitle, Tabs } from '../components/ui.tsx';
import { Button, errorText, helpCls, inputCls, labelCls, Section, tabsTap } from '../components/composer/fields.tsx';
import { Library } from '../components/composer/Library.tsx';
import { Outputs } from '../components/composer/Outputs.tsx';
import { Preview } from '../components/composer/Preview.tsx';
import { SlotField } from '../components/composer/SlotField.tsx';
import { specToExtra, SpecAttach, type SpecMode } from '../components/composer/SpecAttach.tsx';
import { Specify, type SpecifyResult } from '../components/composer/Specify.tsx';
import { TemplatePicker } from '../components/composer/TemplatePicker.tsx';
import { Versions } from '../components/composer/Versions.tsx';

const parseTags = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean);

export default function Composer({ promptId }: { promptId?: string }) {
  const qc = useQueryClient();
  const [top, setTop] = useState<'compose' | 'library'>('compose');
  const [pane, setPane] = useState<'edit' | 'preview'>('edit');
  const [tplId, setTplId] = useState<number | null>(null);
  const [values, setValues] = useState<Values>({});
  const [specMode, setSpecMode] = useState<SpecMode>('md');
  const [specMd, setSpecMd] = useState('');
  const [specFile, setSpecFile] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [id, setId] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const hydrated = useRef<string | null>(null);

  // ---- template ----
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.get<TemplateInfo[]>('/api/templates'), refetchOnWindowFocus: true });
  useEffect(() => {
    if (tplId === null && templates.data?.length && !promptId) setTplId(templates.data[0].id);
  }, [tplId, templates.data, promptId]);
  // refetch so edits to harness-prompt.md on disk show up without a restart
  const detail = useQuery({
    queryKey: ['template', tplId],
    queryFn: () => api.get<TemplateDetail>(`/api/templates/${tplId}`),
    enabled: tplId !== null,
    refetchInterval: 10_000,
  });
  const parsed = detail.data?.parsed;

  // ---- derived prompt ----
  const eff = useMemo<Values>(() => (parsed ? { ...defaultValues(parsed), ...values } : values), [parsed, values]);
  const extraMd = specToExtra(specMode, specMd, specFile);
  const out = useMemo(() => {
    if (!parsed) return { raw: '', markdown: '', warnings: [] };
    return { raw: renderTemplate(parsed, eff, extraMd), markdown: renderTemplate(parsed, eff, extraMd, { preview: true }), warnings: lintPrompt(parsed, eff) };
  }, [parsed, eff, extraMd]);

  // ---- loading a saved prompt ----
  const saved = useQuery({ queryKey: ['prompt', promptId], queryFn: () => api.get<PromptView>(`/api/prompts/${promptId}`), enabled: !!promptId });

  function load(p: { templateId?: number | null; slots: Values; extraMd: string }) {
    if (p.templateId != null) setTplId(p.templateId);
    setValues(p.slots);
    const ref = parseSpecRef(p.extraMd);
    setSpecMode(ref ? 'file' : 'md');
    setSpecFile(ref ?? '');
    setSpecMd(ref ? '' : p.extraMd);
  }
  function reset() {
    setValues({});
    setSpecMode('md');
    setSpecMd('');
    setSpecFile('');
    setTitle('');
    setTags('');
    setId(null);
    setVersion(0);
    setDirty(false);
    setNote('');
    setShowHistory(false);
    if (templates.data?.length) setTplId((cur) => cur ?? templates.data![0].id);
  }
  useEffect(() => {
    if (!promptId) {
      if (hydrated.current) {
        hydrated.current = null;
        reset();
      }
      return;
    }
    const p = saved.data;
    if (p && String(p.id) === promptId && hydrated.current !== promptId) {
      hydrated.current = promptId;
      load(p);
      setTitle(p.title);
      setTags(p.tags.join(', '));
      setId(p.id);
      setVersion(p.version);
      setDirty(false);
      setNote('');
      setTop('compose');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptId, saved.data]);

  // ---- editing ----
  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
    setNote('');
  };
  const setField = (key: string, v: string) => {
    setValues((cur) => ({ ...cur, [key]: v }));
    setDirty(true);
    setNote('');
  };
  const applySpecify = (r: SpecifyResult) => {
    setValues((cur) => ({ ...cur, Goal: r.goal, 'Done when': r.doneWhen.join('\n'), Scope: r.scope }));
    setSpecMode('md');
    setSpecMd(r.spec);
    setDirty(true);
    setNote('Spec-ify filled Goal, Done when, Scope and the spec. Review them, then save.');
  };
  const restore = (v: PromptVersion) => {
    load({ slots: v.slots, extraMd: v.extraMd });
    setDirty(true);
    setTop('compose');
    setNote(`Loaded version ${v.version}. Save to keep it as a new version.`);
  };

  // ---- saving ----
  const save = useMutation({
    mutationFn: (asNew: boolean) => {
      const goal = (eff.Goal ?? '').split('\n')[0].trim();
      const body = { templateId: tplId, title: title.trim() || goal.slice(0, 60) || 'Untitled prompt', slots: eff, extraMd, tags: parseTags(tags) };
      return id && !asNew ? api.put<PromptView>(`/api/prompts/${id}`, body) : api.post<PromptView>('/api/prompts', body);
    },
    onSuccess: (p) => {
      setId(p.id);
      setTitle(p.title);
      setVersion(p.version);
      setDirty(false);
      setNote(`Saved as version ${p.version}`);
      qc.invalidateQueries({ queryKey: ['prompts'] });
      qc.setQueryData(['prompt', String(p.id)], p);
      qc.invalidateQueries({ queryKey: ['prompt-versions', p.id] });
      hydrated.current = String(p.id);
      if (String(p.id) !== promptId) navigate(`/composer/${p.id}`, true);
    },
    onError: (e) => setNote(`Save failed: ${errorText(e)}`),
  });

  async function launch() {
    try {
      let pid = id;
      if (pid === null || dirty) pid = (await save.mutateAsync(false)).id;
      navigate(`/jobs?new=1&prompt=${pid}`);
    } catch {
      // save.onError shows the message
    }
  }

  function newPrompt() {
    hydrated.current = null;
    reset();
    setTop('compose');
    navigate('/composer');
  }

  const warnBy = (key: string) => out.warnings.filter((w) => w.slot === key);
  const warnCount = out.warnings.length;

  return (
    <div>
      <PageTitle right={<Button onClick={newPrompt}>New prompt</Button>}>Composer</PageTitle>
      <Tabs
        tabs={[
          { id: 'compose' as const, label: 'Compose' },
          { id: 'library' as const, label: 'Library' },
        ]}
        value={top}
        onChange={setTop}
        className={`mb-4 ${tabsTap}`}
      />

      {top === 'library' ? (
        <Library
          currentId={id}
          onRestore={restore}
          onDeleted={(deleted) => {
            if (deleted === id) newPrompt();
          }}
        />
      ) : (
        <>
          <Tabs
            tabs={[
              { id: 'edit' as const, label: 'Edit' },
              { id: 'preview' as const, label: warnCount ? `Preview (${warnCount} ⚠)` : 'Preview' },
            ]}
            value={pane}
            onChange={setPane}
            className={`mb-4 lg:hidden ${tabsTap}`}
          />
          {promptId && saved.error && <p className="mb-3 text-error">Could not load this prompt: {errorText(saved.error)}</p>}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
            <div className={`space-y-4 ${pane === 'edit' ? '' : 'hidden lg:block'}`}>
              <Section title="Spec-ify (optional)">
                <Specify onResult={applySpecify} />
              </Section>

              <Section title="Template">
                <TemplatePicker
                  templates={templates.data ?? []}
                  value={tplId}
                  onChange={(v) => {
                    setTplId(v);
                    setDirty(true);
                  }}
                />
              </Section>

              <Section title={detail.data ? `Task (${detail.data.name})` : 'Task'}>
                {!parsed ? (
                  <p className="text-muted">{detail.error ? errorText(detail.error) : 'Loading the template…'}</p>
                ) : (
                  <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
                    {parsed.slots.map((s) => (
                      <SlotField key={s.key} slot={s} values={eff} onChange={setField} warnings={warnBy(s.key)} />
                    ))}
                  </form>
                )}
              </Section>

              <Section title="Attach spec">
                <SpecAttach mode={specMode} md={specMd} file={specFile} onMode={touch(setSpecMode)} onMd={touch(setSpecMd)} onFile={touch(setSpecFile)} />
              </Section>

              <Section title="Save to library" right={version > 0 && <span className="text-[15px] text-muted">v{version}</span>}>
                <div className="space-y-3">
                  <div>
                    <label htmlFor="p-title" className={labelCls}>
                      Title
                    </label>
                    <input id="p-title" className={inputCls} value={title} placeholder="Defaults to the start of the Goal" onChange={(e) => touch(setTitle)(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="p-tags" className={labelCls}>
                      Tags
                    </label>
                    <input id="p-tags" className={inputCls} value={tags} placeholder="comma separated, e.g. backend, nightly" onChange={(e) => touch(setTags)(e.target.value)} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" disabled={!parsed || save.isPending} onClick={() => save.mutate(false)}>
                      {id ? 'Save new version' : 'Save to library'}
                    </Button>
                    {id && (
                      <Button disabled={save.isPending} onClick={() => save.mutate(true)}>
                        Save as new prompt
                      </Button>
                    )}
                    {id && (
                      <Button aria-expanded={showHistory} onClick={() => setShowHistory((s) => !s)}>
                        History
                      </Button>
                    )}
                  </div>
                  <p role="status" className={`${helpCls} ${note.startsWith('Save failed') ? 'text-error' : ''}`}>
                    {note || (dirty && id ? 'Unsaved changes' : '')}
                  </p>
                  {id && showHistory && <Versions promptId={id} onRestore={restore} />}
                </div>
              </Section>
            </div>

            <div className={`space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto ${pane === 'preview' ? '' : 'hidden lg:block'}`}>
              <Section title="Preview">
                <Preview markdown={out.markdown} raw={out.raw} warnings={out.warnings} />
              </Section>
              <Section title="Use it">
                <Outputs raw={out.raw} busy={!parsed || save.isPending} onLaunch={launch} />
              </Section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

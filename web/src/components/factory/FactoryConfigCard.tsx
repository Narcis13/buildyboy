// Settings → Factory: the factory's global values, the gate round limit and how long integrated packages stay on the
// board. Everything per repository (machine, checkout, line file, limits, models, allocation) lives on each project's
// Setup tab (SPEC §12.9).
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FactoryConfig } from '../../../../shared/factory.ts';
import { api } from '../../lib/api.ts';
import { Link } from '../../lib/router.tsx';
import { Field, NumberField, SaveButton, SectionCard } from '../settings/bits.tsx';

/** archive_done_after_hours when unset (server/factory/projects.ts) */
const DEFAULT_ARCHIVE_HOURS = 24;

export function FactoryConfigCard() {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ['factory-config'], queryFn: () => api.get<FactoryConfig>('/api/factory/config') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ archive_done_after_hours: number | null }>('/api/settings') });
  const [maxRounds, setMaxRounds] = useState<number | null>(3);
  const [archiveHours, setArchiveHours] = useState<number | null>(DEFAULT_ARCHIVE_HOURS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (cfg.data && settings.data && !loaded) {
      setMaxRounds(cfg.data.maxRounds);
      setArchiveHours(settings.data.archive_done_after_hours ?? DEFAULT_ARCHIVE_HOURS);
      setLoaded(true);
    }
  }, [cfg.data, settings.data, loaded]);
  const save = useMutation({
    mutationFn: async () => {
      // PUT /api/factory/config still carries §11.7's per-repo list (now the projects' legacy fields): send it back as
      // the server has it right now, so saving the round limit never touches a project
      const fresh = await api.get<FactoryConfig>('/api/factory/config');
      const c = await api.put<FactoryConfig>('/api/factory/config', { maxRounds: maxRounds ?? 3, repos: fresh.repos });
      await api.put('/api/settings', { archive_done_after_hours: archiveHours });
      return c;
    },
    onSuccess: (c) => {
      setMaxRounds(c.maxRounds);
      qc.setQueryData(['factory-config'], c);
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const badRounds = maxRounds == null || maxRounds < 1 || !Number.isInteger(maxRounds);
  const badHours = archiveHours != null && (archiveHours < 0 || !Number.isFinite(archiveHours));
  return (
    <SectionCard
      title="Factory: gates and archive"
      hint={
        <>
          The factory's global values. Where each project's line runs, its limits, models and resources are on its Setup tab in{' '}
          <Link to="/projects" className="text-accent underline" data-testid="fc-projects-link">Projects</Link>.
        </>
      }
      testId="settings-factory-config"
    >
      {(cfg.isLoading || settings.isLoading) && <div className="text-muted">Loading…</div>}
      {cfg.error && <div role="alert" className="text-error">Could not load the config: {(cfg.error as Error).message}</div>}
      {loaded && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Max gate rounds" htmlFor="fc-max-rounds" hint="A package that fails its last round is blocked until you approve one more. A project can override it.">
              <NumberField id="fc-max-rounds" value={maxRounds} onChange={setMaxRounds} min={1} placeholder="3" />
            </Field>
            <Field label="Archive done after (hours)" htmlFor="fc-archive-hours" hint="Integrated packages leave the board for their project's Done tab. 0 keeps them until you archive them.">
              <NumberField id="fc-archive-hours" value={archiveHours} onChange={setArchiveHours} min={0} placeholder={String(DEFAULT_ARCHIVE_HOURS)} />
            </Field>
          </div>
          {badRounds && <div className="text-waiting">Gate rounds is a whole number, at least 1.</div>}
          {badHours && <div className="text-waiting">The archive delay is 0 or more hours.</div>}
          <SaveButton testId="fc-save" pending={save.isPending} error={save.error as Error | null} disabled={badRounds || badHours} onSave={() => save.mutate()} />
        </>
      )}
    </SectionCard>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.ts';

export interface RedactionRule { name: string; pattern: string; flags?: string }

/** GET /api/settings. Missing keys come back as null. */
export interface SettingsData {
  walk_mode: boolean | null;
  pause_all: boolean | null;
  stop_wait_min: number | null;
  retention_days: number | null;
  redaction_rules: RedactionRule[] | null;
  budget_session_usd: number | null;
  budget_job_usd: number | null;
  watchers: Partial<Record<'stale' | 'loop' | 'budget' | 'context' | 'harness', boolean>> | null;
  ntfy_url: string | null;
  quiet_hours: { start: string; end: string } | null;
  push_types: Partial<Record<PushType, boolean>> | null;
  /** "••••••" when set, never the real value */
  github_token: string | null;
  context_threshold_pct: number | null;
  public_url: string;
  vapid_public_key: string | null;
}

export type PushType = 'pending' | 'turn_done' | 'job' | 'stale' | 'loop' | 'ci' | 'budget' | 'context';

export function useSettings() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsData>('/api/settings') });
  const save = useMutation({
    mutationFn: (patch: Partial<Record<keyof SettingsData, unknown>>) => api.put('/api/settings', patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  return { ...query, save };
}

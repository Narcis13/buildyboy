// Settings for the factory (SPEC §11): agent tokens for `bb mcp`, the governor's thresholds, and the daily digest.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentTokenView, DigestView } from '../../../../shared/factory.ts';
import { api } from '../../lib/api.ts';
import { Badge, CopyButton, RelTime, Toggle } from '../ui.tsx';
import { Field, inputClass, NumberField, SaveButton, SectionCard } from './bits.tsx';
import { Button } from './Touch.tsx';
import { useSettings, type SettingsData } from './useSettings.ts';

/** The factory keys of GET /api/settings (missing keys come back as null). */
interface FactorySettings {
  governor_five_hour_pct: number | null;
  governor_seven_day_pct: number | null;
  governor_max_age_min: number | null;
  digest_enabled: boolean | null;
  digest_time: string | null;
}

function useFactorySave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Record<keyof FactorySettings, unknown>>) => api.put('/api/settings', patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
}

export function mcpAddLine(publicUrl: string, token: string): string {
  return `claude mcp add buildyboy --scope user -e BUILDYBOY_URL=${publicUrl} -e BUILDYBOY_AGENT_TOKEN=${token} -- node <path-to-buildyboy>/cli/bb.ts mcp`;
}

function TokensCard({ publicUrl }: { publicUrl: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const tokens = useQuery({ queryKey: ['agent-tokens'], queryFn: () => api.get<AgentTokenView[]>('/api/agent-tokens') });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string; name: string; token: string }>('/api/agent-tokens', { name: name.trim() }),
    onSuccess: (t) => {
      setFresh({ name: t.name, token: t.token });
      setName('');
      qc.invalidateQueries({ queryKey: ['agent-tokens'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/agent-tokens/${id}/revoke`),
    onSettled: () => {
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ['agent-tokens'] });
    },
  });
  const line = fresh ? mcpAddLine(publicUrl, fresh.token) : '';
  return (
    <SectionCard
      title="Factory: agent tokens"
      hint="A token lets the coordinator (bb mcp) read and write the backlog, record gates and ask you decisions. It cannot do anything else."
      testId="settings-factory-tokens"
    >
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <div className="min-w-0 flex-1 basis-48">
          <Field label="Token name" htmlFor="agent-token-name">
            <input id="agent-token-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="coordinator" maxLength={80} className={inputClass} data-testid="agent-token-name" />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending} data-testid="agent-token-create">{create.isPending ? 'Creating…' : 'Create token'}</Button>
      </form>
      {create.error && <div role="alert" className="text-error">{(create.error as Error).message}</div>}

      {fresh && (
        <div className="space-y-3 rounded-lg border border-waiting p-3" data-testid="agent-token-fresh">
          <div className="font-medium">Token “{fresh.name}” — shown only once</div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-bg-2 p-2 font-mono text-sm" data-testid="agent-token-value">{fresh.token}</code>
            <CopyButton text={fresh.token} label="Copy token" />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[15px] font-medium">Register it with Claude Code</span>
              <CopyButton text={line} label="Copy command" />
            </div>
            <pre className="whitespace-pre-wrap break-all rounded-lg border border-line bg-bg-2 p-3 font-mono text-sm leading-snug" data-testid="agent-token-command">{line}</pre>
            <p className="mt-1 text-sm text-muted">Replace <code className="font-mono">&lt;path-to-buildyboy&gt;</code> with the folder this repo is checked out in on that machine.</p>
          </div>
          <Button onClick={() => setFresh(null)} data-testid="agent-token-dismiss">I have copied it</Button>
        </div>
      )}

      {tokens.isLoading && <div className="text-muted">Loading…</div>}
      {tokens.data && tokens.data.length === 0 && <div className="text-muted">No tokens yet.</div>}
      {tokens.data && tokens.data.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line" data-testid="agent-token-list">
          {tokens.data.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid="agent-token-row" data-revoked={t.revokedAt ? 'true' : 'false'}>
              <div className="min-w-0 flex-1 basis-40">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium [overflow-wrap:anywhere]">{t.name}</span>
                  {t.revokedAt && <Badge color="var(--bb-error)">revoked</Badge>}
                </div>
                <div className="text-sm text-muted">
                  created <RelTime ts={t.createdAt} /> · last used {t.lastUsedAt ? <RelTime ts={t.lastUsedAt} /> : 'never'}
                  {t.revokedAt ? <> · revoked <RelTime ts={t.revokedAt} /></> : null}
                </div>
              </div>
              {!t.revokedAt &&
                (confirm === t.id ? (
                  <div className="flex gap-2">
                    <Button variant="danger" disabled={revoke.isPending} onClick={() => revoke.mutate(t.id)} data-testid="agent-token-revoke-confirm">Revoke</Button>
                    <Button onClick={() => setConfirm(null)}>Keep</Button>
                  </div>
                ) : (
                  <Button onClick={() => setConfirm(t.id)} data-testid="agent-token-revoke">Revoke…</Button>
                ))}
            </li>
          ))}
        </ul>
      )}
      {revoke.error && <div role="alert" className="text-error">{(revoke.error as Error).message}</div>}
    </SectionCard>
  );
}

function GovernorCard({ s }: { s: FactorySettings }) {
  const save = useFactorySave();
  const [five, setFive] = useState<number | null>(s.governor_five_hour_pct);
  const [seven, setSeven] = useState<number | null>(s.governor_seven_day_pct);
  const [age, setAge] = useState<number | null>(s.governor_max_age_min);
  const bad = [five, seven].some((v) => v != null && (v < 1 || v > 100)) || (age != null && age < 1);
  return (
    <SectionCard
      title="Factory: consumption governor"
      hint="New workers wait while the 5-hour or 7-day usage is above these limits, or when the usage data is older than the age limit. Empty uses the default."
      testId="settings-factory-governor"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="5-hour limit (%)" htmlFor="gov-five">
          <NumberField id="gov-five" value={five} onChange={setFive} min={1} placeholder="85" />
        </Field>
        <Field label="7-day limit (%)" htmlFor="gov-seven">
          <NumberField id="gov-seven" value={seven} onChange={setSeven} min={1} placeholder="80" />
        </Field>
        <Field label="Max data age (min)" htmlFor="gov-age">
          <NumberField id="gov-age" value={age} onChange={setAge} min={1} placeholder="30" />
        </Field>
      </div>
      {bad && <div className="text-waiting">The limits are percentages from 1 to 100; the age is at least 1 minute.</div>}
      <SaveButton
        testId="governor-save"
        pending={save.isPending}
        error={save.error as Error | null}
        disabled={bad}
        onSave={() => save.mutate({ governor_five_hour_pct: five, governor_seven_day_pct: seven, governor_max_age_min: age })}
      />
    </SectionCard>
  );
}

function DigestCard({ s }: { s: FactorySettings }) {
  const qc = useQueryClient();
  const save = useFactorySave();
  const [enabled, setEnabled] = useState(s.digest_enabled ?? true);
  const [time, setTime] = useState(s.digest_time ?? '08:00');
  const digests = useQuery({ queryKey: ['digests'], queryFn: () => api.get<DigestView[]>('/api/digests') });
  const send = useMutation({
    mutationFn: () => api.post<DigestView>('/api/digests', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['digests'] }),
  });
  const badTime = !/^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  return (
    <SectionCard title="Factory: digest" hint="A summary on your phone once a day: what was integrated, the gates, usage and the decisions that wait." testId="settings-factory-digest">
      <Toggle on={enabled} onChange={setEnabled} label="Send the daily digest" />
      <Field label="Time (server local time)" htmlFor="digest-time">
        <input id="digest-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className={`${inputClass} sm:max-w-[12rem]`} data-testid="digest-time" />
      </Field>
      {badTime && <div className="text-waiting">Use the HH:MM format.</div>}
      <SaveButton testId="digest-save" pending={save.isPending} error={save.error as Error | null} disabled={badTime} onSave={() => save.mutate({ digest_enabled: enabled, digest_time: time })} />
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Button disabled={send.isPending} onClick={() => send.mutate()} data-testid="digest-send">{send.isPending ? 'Sending…' : 'Send digest now'}</Button>
        {send.isSuccess && <span className="text-working" role="status">Sent</span>}
        {send.error && <span className="text-error" role="alert">{(send.error as Error).message}</span>}
      </div>
      {digests.data && digests.data.length > 0 && (
        <ul className="space-y-1" data-testid="digest-list">
          {digests.data.slice(0, 5).map((d) => (
            <li key={d.id}>
              <details className="rounded-lg border border-line">
                <summary className="flex min-h-[44px] cursor-pointer flex-wrap items-center gap-x-3 px-3 py-1">
                  <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
                  <Badge>{d.kind}</Badge>
                  <RelTime ts={d.ts} className="text-sm text-muted" />
                </summary>
                <pre className="whitespace-pre-wrap border-t border-line p-3 font-sans text-[15px] [overflow-wrap:anywhere]">{d.body}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/** The three factory cards, for the Settings page. */
export function FactorySection() {
  const { data } = useSettings();
  if (!data) return null;
  const s = data as SettingsData & FactorySettings;
  return (
    <>
      <TokensCard publicUrl={data.public_url} />
      <GovernorCard s={s} />
      <DigestCard s={s} />
    </>
  );
}

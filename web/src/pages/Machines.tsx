import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MachineSummary } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { Badge, Card, CopyButton, Empty, Lamp, PageTitle, RelTime } from '../components/ui.tsx';
import { Button } from '../components/settings/Touch.tsx';
import { PairMachine } from '../components/settings/PairMachine.tsx';

const platformLabel = (p: string | null) => (p === 'win32' ? 'Windows' : p === 'wsl' ? 'WSL' : p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : (p ?? 'unknown'));

function bytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="truncate text-[15px]">{children}</dd>
    </div>
  );
}

type Walk = true | false | null;

function WalkChoice({ value, onChange, disabled, name }: { value: Walk; onChange: (v: Walk) => void; disabled?: boolean; name: string }) {
  const opts: { v: Walk; label: string }[] = [{ v: null, label: 'Inherit' }, { v: true, label: 'On' }, { v: false, label: 'Off' }];
  return (
    <div role="radiogroup" aria-label={`Walk mode for ${name}`} className="inline-flex overflow-hidden rounded-lg border border-line" data-testid="machine-walk">
      {opts.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          disabled={disabled}
          onClick={() => onChange(o.v)}
          className={`min-h-[44px] min-w-16 px-4 text-[15px] transition ${value === o.v ? (o.v === true ? 'bg-waiting text-[#1d1300]' : 'bg-accent text-accent-ink') : 'bg-panel-2 text-muted hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function MachineCard({ m }: { m: MachineSummary }) {
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(m.name);
  const [confirm, setConfirm] = useState<null | 'rotate' | 'revoke'>(null);
  const done = () => qc.invalidateQueries({ queryKey: ['machines'] });
  const walk = useMutation({ mutationFn: (on: Walk) => api.post(`/api/machines/${m.id}/walk`, { on }), onSuccess: done });
  const rename = useMutation({ mutationFn: () => api.post(`/api/machines/${m.id}/rename`, { name: name.trim() }), onSuccess: () => { setRenaming(false); done(); } });
  const rotate = useMutation({ mutationFn: () => api.post<{ ok: boolean; token: string }>(`/api/machines/${m.id}/rotate`), onSuccess: () => { setConfirm(null); done(); } });
  const revoke = useMutation({ mutationFn: () => api.post(`/api/machines/${m.id}/revoke`), onSuccess: () => { setConfirm(null); done(); } });
  const err = (walk.error ?? rename.error ?? rotate.error ?? revoke.error) as Error | null;

  const lastQuiet = m.lastSeen != null && Date.now() - m.lastSeen > 10 * 60_000;

  return (
    <Card className={`p-4 ${m.revoked ? 'opacity-70' : ''}`} data-testid="machine-card" data-machine={m.name}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Lamp status={m.revoked ? 'error' : m.online ? 'working' : 'ended'} size={16} />
          {renaming ? (
            <form className="flex min-w-0 flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) rename.mutate(); }}>
              <input aria-label="Machine name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus
                className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-line bg-bg-2 px-3 text-base outline-none focus:border-accent" data-testid="rename-input" />
              <Button type="submit" variant="primary" disabled={rename.isPending || !name.trim()} data-testid="rename-save">Save</Button>
              <Button type="button" onClick={() => { setRenaming(false); setName(m.name); }}>Cancel</Button>
            </form>
          ) : (
            <h2 className="min-w-0 truncate text-lg font-semibold" data-testid="machine-name">{m.name}</h2>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {m.revoked ? <Badge color="var(--bb-error)">revoked</Badge> : <Badge color={m.online ? 'var(--bb-working)' : 'var(--bb-muted)'}>{m.online ? 'online' : 'offline'}</Badge>}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Platform">{platformLabel(m.platform)}{m.hostname ? <span className="text-muted"> · {m.hostname}</span> : null}</Fact>
        <Fact label="Claude Code">{m.claudeVersion ?? '—'}</Fact>
        <Fact label="Hook">{m.hookVersion ?? '—'}</Fact>
        <Fact label="Last event"><RelTime ts={m.lastSeen} className={lastQuiet ? 'text-waiting' : ''} /></Fact>
        <Fact label="Spool">{bytes(m.spoolBytes)}</Fact>
        <Fact label="Runner">{m.runnerOnline ? <span className="text-working">connected</span> : <span className="text-muted">not running</span>}</Fact>
      </dl>

      {!m.revoked && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-[15px]">Walk mode</span>
            <WalkChoice value={m.walkMode} name={m.name} disabled={walk.isPending} onChange={(v) => walk.mutate(v)} />
            <span className="text-sm text-muted">{m.walkMode == null ? 'follows the global setting' : m.walkMode ? 'always on for this machine' : 'never waits for you here'}</span>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {!renaming && <Button onClick={() => { setName(m.name); setRenaming(true); }} data-testid="machine-rename">Rename</Button>}
            <Button onClick={() => setConfirm(confirm === 'rotate' ? null : 'rotate')} data-testid="machine-rotate">Rotate token</Button>
            <Button variant="danger" onClick={() => setConfirm(confirm === 'revoke' ? null : 'revoke')} data-testid="machine-revoke">Revoke</Button>
          </div>

          {confirm === 'rotate' && (
            <div className="mt-3 space-y-2 rounded-lg border border-waiting p-3" role="alertdialog" aria-label="Confirm token rotation">
              <p className="text-[15px]">The current token stops working immediately. The new one is shown once; put it in <code className="font-mono">~/.buildyboy/config.json</code> on that machine (or pair it again).</p>
              <div className="flex gap-2">
                <Button variant="warn" disabled={rotate.isPending} onClick={() => rotate.mutate()} data-testid="rotate-confirm">Rotate now</Button>
                <Button onClick={() => setConfirm(null)}>Cancel</Button>
              </div>
            </div>
          )}
          {confirm === 'revoke' && (
            <div className="mt-3 space-y-2 rounded-lg border border-error p-3" role="alertdialog" aria-label="Confirm revoke">
              <p className="text-[15px]">Revoking {m.name} cuts off its hooks and runner for good. Its history stays. This cannot be undone; pair the machine again to reconnect.</p>
              <div className="flex gap-2">
                <Button variant="danger" disabled={revoke.isPending} onClick={() => revoke.mutate()} data-testid="revoke-confirm">Revoke {m.name}</Button>
                <Button onClick={() => setConfirm(null)}>Cancel</Button>
              </div>
            </div>
          )}
          {rotate.data?.token && (
            <div className="mt-3 space-y-2 rounded-lg border border-accent p-3" data-testid="rotated-token">
              <div className="text-[15px] font-medium">New token (shown once)</div>
              <code className="block break-all rounded bg-bg-2 p-2 font-mono text-sm">{rotate.data.token}</code>
              <CopyButton text={rotate.data.token} label="Copy token" />
            </div>
          )}
        </>
      )}
      {err && <div role="alert" className="mt-3 text-error">{err.message}</div>}
    </Card>
  );
}

export default function Machines() {
  const { data, isLoading, error } = useQuery({ queryKey: ['machines'], queryFn: () => api.get<MachineSummary[]>('/api/machines'), refetchInterval: 20_000 });
  return (
    <div data-testid="machines-page" className="mx-auto max-w-5xl">
      <PageTitle>Machines</PageTitle>
      <div className="mb-4"><PairMachine /></div>
      {error && <div role="alert" className="mb-3 text-error">Could not load machines: {(error as Error).message}</div>}
      {isLoading && <div className="text-muted">Loading…</div>}
      {data && data.length === 0 && <Empty>No machines yet. Pair one to start seeing its sessions.</Empty>}
      <div className="space-y-3">{data?.map((m) => <MachineCard key={m.id} m={m} />)}</div>

      <Card className="mt-6 p-4" data-testid="hook-health">
        <h2 className="mb-1 text-base font-semibold">Hook health</h2>
        <p className="text-[15px] text-muted">
          “Last event” above is when this machine's hook last reached the server; amber means it has been quiet for 10 minutes (normal if no session is running).
          For a real round-trip test, run <code className="font-mono text-ink">/bb-status</code> inside Claude Code, or <code className="font-mono text-ink">bb doctor</code> in a terminal on that machine. Both send a test event and report whether the server answered.
        </p>
        <p className="mt-2 text-[15px] text-muted">Windows and WSL are separate machines here because they have separate <code className="font-mono">~/.claude</code> folders. Pair each one.</p>
      </Card>
    </div>
  );
}

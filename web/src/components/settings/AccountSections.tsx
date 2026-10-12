import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.ts';
import { Badge, RelTime } from '../ui.tsx';
import { Button } from './Touch.tsx';
import { Field, inputClass, SectionCard } from './bits.tsx';

interface Device { id: string; device: string; ip: string; created_at: number; last_seen_at: number; current: boolean }

/** "Mozilla/5.0 (Windows NT 10.0…) Chrome/141…" -> "Chrome on Windows" */
export function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|undici/i.test(ua) ? 'Script' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  return `${browser} on ${os}`;
}

export function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const change = useMutation({
    mutationFn: () => api.post('/api/auth/password', { current, next }),
    onSuccess: () => { setCurrent(''); setNext(''); setAgain(''); },
  });
  const problem = next && next.length < 8 ? 'At least 8 characters.' : again && again !== next ? 'The two new passwords differ.' : null;
  return (
    <SectionCard title="Password" testId="settings-password">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!problem && current && next) change.mutate(); }}>
        <Field label="Current password" htmlFor="pw-current"><input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={inputClass} /></Field>
        <Field label="New password" htmlFor="pw-next" hint="At least 8 characters."><input id="pw-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={inputClass} /></Field>
        <Field label="New password again" htmlFor="pw-again"><input id="pw-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} className={inputClass} /></Field>
        {problem && <div className="text-waiting">{problem}</div>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={change.isPending || !!problem || !current || !next || !again} data-testid="password-save">Change password</Button>
          {change.isSuccess && <span className="text-working" role="status">Password changed</span>}
          {change.error && <span className="text-error" role="alert">{(change.error as Error).message}</span>}
        </div>
      </form>
    </SectionCard>
  );
}

export function DevicesSection() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['devices'], queryFn: () => api.get<Device[]>('/api/auth/devices') });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/api/auth/devices/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }) });
  const logout = useMutation({
    mutationFn: () => api.post('/api/auth/logout'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  return (
    <SectionCard title="Devices" hint="Browsers that are logged in. Log out the ones you do not recognise." testId="settings-devices">
      {error && <div role="alert" className="text-error">{(error as Error).message}</div>}
      <ul className="space-y-2">
        {data?.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line p-3" data-testid="device-row">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-[15px] font-medium">
                {deviceLabel(d.device)}
                {d.current && <Badge color="var(--bb-working)">this device</Badge>}
              </div>
              <div className="text-sm text-muted">{d.ip} · active <RelTime ts={d.last_seen_at} /> · since <RelTime ts={d.created_at} /></div>
            </div>
            {!d.current && <Button size="sm" disabled={remove.isPending} onClick={() => remove.mutate(d.id)} data-testid="device-logout">Log out</Button>}
          </li>
        ))}
      </ul>
      <Button variant="danger" disabled={logout.isPending} onClick={() => logout.mutate()} data-testid="logout">Log out of this device</Button>
    </SectionCard>
  );
}

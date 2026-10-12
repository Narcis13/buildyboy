import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api.ts';
import { Toggle } from '../ui.tsx';
import { Button } from './Touch.tsx';
import { Field, inputClass, SaveButton, SectionCard } from './bits.tsx';
import { useSettings, type PushType, type SettingsData } from './useSettings.ts';

const TYPES: { id: PushType; label: string }[] = [
  { id: 'pending', label: 'Permission, question or plan waiting' },
  { id: 'turn_done', label: 'Turn finished (walk mode)' },
  { id: 'job', label: 'Job finished or failed' },
  { id: 'stale', label: 'Session went stale' },
  { id: 'loop', label: 'Loop suspected' },
  { id: 'ci', label: 'CI result on a PR' },
  { id: 'budget', label: 'Budget or rate limit' },
  { id: 'context', label: 'Context nearly full' },
];

function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

const withTimeout = <T,>(p: Promise<T>, ms: number, msg: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

type PushState = 'unknown' | 'unsupported' | 'off' | 'on' | 'denied';

/** Web Push for this device: subscribe through the service worker, then register the subscription with the server. */
function WebPush() {
  const [state, setState] = useState<PushState>('unknown');
  const [deviceName, setDeviceName] = useState(guessDeviceName);
  const [note, setNote] = useState<string | null>(null);

  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  useEffect(() => {
    if (!supported) { setState('unsupported'); return; }
    if (Notification.permission === 'denied') { setState('denied'); return; }
    let live = true;
    // `ready` never resolves without a registered worker (dev builds, plain http), so don't wait on it for the initial state
    withTimeout(navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()), 2500, 'no service worker')
      .then((sub) => live && setState(sub ? 'on' : 'off'))
      .catch(() => live && setState('off'));
    return () => { live = false; };
  }, [supported]);

  const enable = useMutation({
    mutationFn: async () => {
      if (!supported) throw new Error('This browser does not support Web Push. On iPhone, add Buildyboy to the home screen first.');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setState('denied'); throw new Error('Notifications are blocked for this site. Allow them in the browser settings.'); }
      const reg = await withTimeout(navigator.serviceWorker.ready, 5000, 'The service worker is not active. Web Push needs HTTPS (or localhost) and the production build.');
      const { publicKey } = await api.get<{ publicKey: string }>('/api/push/vapid');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await api.post('/api/push/subscribe', { subscription: sub.toJSON(), deviceName: deviceName.trim() || guessDeviceName() });
    },
    onSuccess: () => { setState('on'); setNote('Notifications are on for this device.'); },
  });

  const disable = useMutation({
    mutationFn: async () => {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
    },
    onSuccess: () => { setState('off'); setNote('Notifications are off for this device.'); },
  });

  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; push?: number; ntfy?: boolean }>('/api/push/test'),
  });

  const err = (enable.error ?? disable.error) as Error | null;
  return (
    <div className="space-y-3" data-testid="web-push">
      <div className="flex flex-wrap items-center gap-2 text-[15px]">
        <span className="font-medium">Web Push on this device:</span>
        <span data-testid="push-state" className={state === 'on' ? 'text-working' : state === 'denied' || state === 'unsupported' ? 'text-waiting' : 'text-muted'}>
          {{ unknown: 'checking…', unsupported: 'not supported here', off: 'off', on: 'on', denied: 'blocked' }[state]}
        </span>
      </div>
      {state === 'unsupported' && <p className="text-sm text-muted">This browser cannot receive Web Push. Use the ntfy topic below, or install the app to the home screen.</p>}
      {state === 'denied' && <p className="text-sm text-muted">Notifications are blocked for this site. Allow them in the browser's site settings, then try again.</p>}
      {(state === 'off' || state === 'unknown') && (
        <>
          <Field label="Name this device" htmlFor="push-device"><input id="push-device" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={80} className={inputClass} /></Field>
          <Button variant="primary" disabled={enable.isPending || state === 'unknown'} onClick={() => enable.mutate()} data-testid="push-enable">{enable.isPending ? 'Enabling…' : 'Enable notifications on this device'}</Button>
        </>
      )}
      {state === 'on' && <Button disabled={disable.isPending} onClick={() => disable.mutate()} data-testid="push-disable">Turn off for this device</Button>}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={test.isPending} onClick={() => test.mutate()} data-testid="push-test">Send test notification</Button>
        {test.data && <span className="text-working" role="status" data-testid="push-test-result">Sent to {test.data.push ?? 0} device{test.data.push === 1 ? '' : 's'}{test.data.ntfy ? ' and ntfy' : ''}.</span>}
        {test.error && <span className="text-error" role="alert">{(test.error as Error).message}</span>}
      </div>
      {note && !err && <div className="text-working" role="status">{note}</div>}
      {err && <div className="text-error" role="alert">{err.message}</div>}
    </div>
  );
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function NotificationsSection({ data }: { data: SettingsData }) {
  const { save } = useSettings();
  const [ntfy, setNtfy] = useState(data.ntfy_url ?? '');
  const [quiet, setQuiet] = useState(!!data.quiet_hours);
  const [start, setStart] = useState(data.quiet_hours?.start ?? '22:00');
  const [end, setEnd] = useState(data.quiet_hours?.end ?? '07:00');
  const [types, setTypes] = useState<Record<string, boolean>>(() => Object.fromEntries(TYPES.map((t) => [t.id, data.push_types?.[t.id] !== false])));
  const badTime = quiet && (!HHMM.test(start) || !HHMM.test(end));
  const badUrl = ntfy.trim() !== '' && !/^https?:\/\/\S+$/.test(ntfy.trim());

  return (
    <SectionCard title="Notifications" hint="Pushes go to every subscribed device. Pending permissions can be allowed or denied right from the notification." testId="settings-notifications">
      <WebPush />
      <Field label="ntfy topic URL" htmlFor="ntfy-url" hint="Optional fallback, e.g. https://ntfy.sh/my-secret-topic. Handy on iPhone when the app is not installed.">
        <input id="ntfy-url" type="url" inputMode="url" value={ntfy} onChange={(e) => setNtfy(e.target.value)} placeholder="https://ntfy.sh/…" className={inputClass} data-testid="ntfy-url" />
      </Field>
      <div>
        <Toggle on={quiet} onChange={setQuiet} label="Quiet hours" />
        {quiet && (
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Field label="From" htmlFor="quiet-start"><input id="quiet-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} className={inputClass} /></Field>
            <Field label="Until" htmlFor="quiet-end"><input id="quiet-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={inputClass} /></Field>
          </div>
        )}
      </div>
      <fieldset>
        <legend className="mb-1 text-[15px] font-medium">Send notifications for</legend>
        <div className="grid sm:grid-cols-2">
          {TYPES.map((t) => <Toggle key={t.id} on={types[t.id]} onChange={(v) => setTypes((s) => ({ ...s, [t.id]: v }))} label={t.label} />)}
        </div>
      </fieldset>
      {badUrl && <div className="text-waiting">The ntfy URL must start with http:// or https://</div>}
      {badTime && <div className="text-waiting">Use 24-hour times such as 22:00.</div>}
      <SaveButton
        testId="notifications-save"
        pending={save.isPending}
        error={save.error as Error | null}
        disabled={badUrl || badTime}
        onSave={() => save.mutate({ ntfy_url: ntfy.trim() || null, quiet_hours: quiet ? { start, end } : null, push_types: types })}
      />
    </SectionCard>
  );
}

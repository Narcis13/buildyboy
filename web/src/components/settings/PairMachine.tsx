import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api.ts';
import { Card, CopyButton } from '../ui.tsx';
import { Button } from './Touch.tsx';

interface PairingCode {
  code: string;
  expiresAt: number;
  commands: { bash: string; powershell: string };
}

function Command({ label, text, testId }: { label: string; text: string; testId: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[15px] font-medium">{label}</span>
        <CopyButton text={text} />
      </div>
      <pre data-testid={testId} className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-bg-2 p-3 font-mono text-sm">{text}</pre>
    </div>
  );
}

/** Creates a 10-minute pairing code and shows the install commands for Linux/WSL and Windows. */
export function PairMachine() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [now, setNow] = useState(Date.now());
  const create = useMutation({ mutationFn: () => api.post<PairingCode>('/api/pairing-codes', { name: name.trim() || undefined }) });
  const pairing = create.data;

  useEffect(() => {
    if (!pairing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pairing]);

  if (!open) {
    return <Button variant="primary" data-testid="pair-open" onClick={() => setOpen(true)}>Pair a machine</Button>;
  }

  const left = pairing ? Math.max(0, pairing.expiresAt - now) : 0;
  const mm = String(Math.floor(left / 60_000)).padStart(2, '0');
  const ss = String(Math.floor((left % 60_000) / 1000)).padStart(2, '0');

  return (
    <Card className="mb-4 w-full p-4" data-testid="pair-panel">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Pair a machine</h2>
        <Button size="sm" onClick={() => { setOpen(false); create.reset(); setName(''); }}>Close</Button>
      </div>
      {!pairing && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <label className="block text-sm text-muted" htmlFor="pair-name">Name for this machine (optional)</label>
          <input id="pair-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. work-laptop" maxLength={60}
            className="min-h-[44px] w-full rounded-lg border border-line bg-bg-2 px-3 text-base outline-none focus:border-accent" data-testid="pair-name" />
          <Button type="submit" variant="primary" disabled={create.isPending} data-testid="pair-create">{create.isPending ? 'Creating…' : 'Create pairing code'}</Button>
          {create.error && <div role="alert" className="text-error">Could not create a code: {(create.error as Error).message}</div>}
        </form>
      )}
      {pairing && (
        <div className="space-y-4">
          <div className="text-center">
            <div className="select-all break-all font-mono text-4xl font-bold tracking-[0.2em]" data-testid="pair-code">{pairing.code}</div>
            <div className={`mt-1 font-mono text-lg ${left === 0 ? 'text-error' : left < 60_000 ? 'text-waiting' : 'text-muted'}`} data-testid="pair-countdown">
              {left === 0 ? 'Expired' : `Expires in ${mm}:${ss}`}
            </div>
            {left === 0 && <Button className="mt-2" onClick={() => create.mutate()}>New code</Button>}
          </div>
          <Command label="Linux, macOS and WSL" text={pairing.commands.bash} testId="pair-bash" />
          <Command label="Windows (PowerShell)" text={pairing.commands.powershell} testId="pair-powershell" />
          <p className="rounded-lg bg-panel-2 p-3 text-[15px]">
            Windows and WSL keep separate <code className="font-mono">~/.claude</code> folders, so run the installer in <strong>both</strong> if you use Claude Code in both. Each one becomes its own machine here.
            The code works once and expires after 10 minutes.
          </p>
        </div>
      )}
    </Card>
  );
}

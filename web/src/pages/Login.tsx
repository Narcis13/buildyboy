import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.ts';
import { navigate, useQueryParam } from '../lib/router.tsx';
import { Button, Card } from '../components/ui.tsx';

export function Login({ setup = false }: { setup?: boolean }) {
  const token = useQueryParam('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (setup && password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      if (setup) await api.post('/api/auth/setup', { token, password });
      else await api.post('/api/auth/login', { password });
      await qc.invalidateQueries();
      navigate('/', true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bb-grid flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-10 w-10" />
          <div>
            <div className="text-lg font-semibold tracking-wide">Buildyboy</div>
            <div className="text-sm text-muted">{setup ? 'Choose a password to finish setup' : 'Software factory floor'}</div>
          </div>
        </div>
        {setup && !token && <p className="mb-3 text-sm text-error">Open the setup link printed in the server log.</p>}
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted">
            Password
            <input
              type="password"
              name="password"
              autoComplete={setup ? 'new-password' : 'current-password'}
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="min-h-[44px] rounded-lg border border-line bg-bg-2 px-3 text-base text-ink outline-none focus:border-accent"
            />
          </label>
          {setup && (
            <label className="flex flex-col gap-1 text-sm text-muted">
              Confirm password
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="min-h-[44px] rounded-lg border border-line bg-bg-2 px-3 text-base text-ink outline-none focus:border-accent" />
            </label>
          )}
          {error && <p role="alert" className="text-sm text-error">{error}</p>}
          <Button type="submit" variant="primary" size="lg" disabled={busy || !password}>
            {setup ? 'Set password' : 'Log in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}

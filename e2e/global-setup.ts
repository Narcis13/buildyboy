// Starts a server on a random port with a temp data dir, replays the fixtures, and tears it all down after.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const E2E_PASSWORD = 'e2e-password-123';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export default async function globalSetup() {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'bb-e2e-'));
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/main.ts'], {
    env: { ...process.env, BUILDYBOY_PORT: String(port), BUILDYBOY_DATA: dataDir, BUILDYBOY_INITIAL_PASSWORD: E2E_PASSWORD, BUILDYBOY_PERMISSION_WAIT_MS: '60000' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  execFileSync(process.execPath, ['scripts/simulate.ts', '--url', url, '--data', dataDir], { stdio: 'inherit' });
  process.env.BB_E2E_URL = url;
  process.env.BB_E2E_DATA = dataDir;
  process.env.BB_E2E_PASSWORD = E2E_PASSWORD;
  return async () => {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };
}

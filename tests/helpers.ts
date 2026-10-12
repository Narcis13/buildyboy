import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from '../server/main.ts';
import type { ServerConfig } from '../server/context.ts';

export interface TestServer extends RunningServer {
  dataDir: string;
  /** logs in and returns fetch helpers with the session cookie + CSRF header */
  login(): Promise<WebClient>;
  stop(): Promise<void>;
}

export interface WebClient {
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  put<T = any>(path: string, body?: unknown): Promise<T>;
}

export const TEST_PASSWORD = 'correct-horse-battery';

export async function startTestServer(over: Partial<ServerConfig> = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bb-test-'));
  process.env.BUILDYBOY_INITIAL_PASSWORD = TEST_PASSWORD;
  const s = await startServer({ port: 0, dataDir, ...over }, { quiet: true, background: false });
  delete process.env.BUILDYBOY_INITIAL_PASSWORD;
  return {
    ...s,
    dataDir,
    async login() {
      const res = await fetch(`${s.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: TEST_PASSWORD }) });
      if (!res.ok) throw new Error(`login failed ${res.status}`);
      const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
      const csrf = cookies.find((c) => c.startsWith('bb_csrf='))!.slice('bb_csrf='.length);
      const headers = { cookie: cookies.join('; '), 'x-bb-csrf': csrf, 'content-type': 'application/json' };
      const call = async (method: string, path: string, body?: unknown) => {
        const r = await fetch(`${s.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await r.text();
        if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
        return text ? JSON.parse(text) : null;
      };
      return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) };
    },
    async stop() {
      await s.close();
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Windows may hold the WAL briefly
      }
    },
  };
}

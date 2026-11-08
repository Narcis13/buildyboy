import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, type TestServer } from './helpers.ts';

// After a deploy, an open tab must not keep an index.html that names chunks the new build no longer has.
describe('the web app shell', () => {
  let s: TestServer;
  let dist: string;

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), 'bb-dist-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><script type="module" src="/assets/index-NEW.js"></script>');
    writeFileSync(join(dist, 'assets', 'index-NEW.js'), 'export {};');
    writeFileSync(join(dist, 'sw.js'), '// sw');
    process.env.BUILDYBOY_WEB_DIST = dist;
    s = await startTestServer();
  });

  afterAll(async () => {
    delete process.env.BUILDYBOY_WEB_DIST;
    await s?.stop();
    rmSync(dist, { recursive: true, force: true });
  });

  it('revalidates index.html, both at / and on a client route', async () => {
    for (const path of ['/', '/s/abc', '/backlog/T70.4']) {
      const r = await fetch(`${s.url}${path}`);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('cache-control'), path).toBe('no-cache');
      expect(await r.text(), path).toContain('index-NEW.js');
    }
  });

  it('caches hashed assets forever and revalidates the service worker', async () => {
    const asset = await fetch(`${s.url}/assets/index-NEW.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const sw = await fetch(`${s.url}/sw.js`);
    expect(sw.status).toBe(200);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
  });

  it("answers an old build's missing chunk with 404, not the app shell", async () => {
    const r = await fetch(`${s.url}/assets/Session-OLD.js`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type') ?? '').not.toContain('text/html');
  });
});

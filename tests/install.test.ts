import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { startTestServer, type TestServer } from './helpers.ts';

let srv: TestServer;
let work: string;

beforeAll(async () => {
  srv = await startTestServer({ publicUrl: 'https://bb.example.test' });
  work = mkdtempSync(join(tmpdir(), 'bb-install-test-'));
});
afterAll(async () => {
  await srv.stop();
  rmSync(work, { recursive: true, force: true });
});

/** Reads a ustar archive: name -> content (directories map to null). */
function parseTar(tar: Buffer): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, n: number) => h.toString('utf8', a, a + n).replace(/\0.*$/s, '');
    const name = [str(345, 155), str(0, 100)].filter(Boolean).join('/');
    const size = parseInt(str(124, 12), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    expect(parseInt(str(148, 6), 8), `checksum of ${name}`).toBe(sum);
    const type = String.fromCharCode(h[156]);
    off += 512;
    if (type === '5') out.set(name, null);
    else {
      out.set(name, tar.subarray(off, off + size));
      off += Math.ceil(size / 512) * 512;
    }
  }
  return out;
}

describe('installer routes', () => {
  it('serves install.sh with the public URL substituted', async () => {
    const res = await fetch(`${srv.url}/install.sh`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const text = await res.text();
    expect(text).toContain('https://bb.example.test');
    expect(text).not.toContain('__BB_URL__');
    expect(text.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(text).not.toContain('\r');
  });

  it('serves install.ps1 with the public URL substituted', async () => {
    const res = await fetch(`${srv.url}/install.ps1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const text = await res.text();
    expect(text).toContain('https://bb.example.test/install.ps1');
    expect(text).not.toContain('__BB_URL__');
  });

  it('serves a plugin tarball that is a one-plugin marketplace', async () => {
    const res = await fetch(`${srv.url}/plugin.tgz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    const gz = Buffer.from(await res.arrayBuffer());
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);

    const files = parseTar(gunzipSync(gz));
    expect([...files.keys()]).toContain('plugin/hooks/bb-hook.mjs');
    expect([...files.keys()]).toContain('.claude-plugin/marketplace.json');
    expect([...files.keys()].filter((n) => !n.endsWith('/') && n.startsWith('.claude-plugin/'))).toEqual(['.claude-plugin/marketplace.json']);
    const marketplace = JSON.parse(files.get('.claude-plugin/marketplace.json')!.toString('utf8'));
    expect(marketplace.name).toBe('buildyboy');
    expect(marketplace.plugins[0].source).toBe('./plugin');
    const hook = readFileSync(join(srv.ctx.config.rootDir, 'plugin/hooks/bb-hook.mjs'));
    expect(files.get('plugin/hooks/bb-hook.mjs')!.equals(hook)).toBe(true);
  });

  it('produces an archive that the system tar can extract', async () => {
    const gz = Buffer.from(await (await fetch(`${srv.url}/plugin.tgz`)).arrayBuffer());
    const file = join(work, 'plugin.tgz');
    const dest = join(work, 'out');
    writeFileSync(file, gz);
    mkdirSync(dest, { recursive: true });
    try {
      // relative paths: GNU tar reads 'C:\...' as a remote host
      execFileSync('tar', ['-xzf', 'plugin.tgz', '-C', 'out'], { stdio: 'pipe', cwd: work });
    } catch (e) {
      // no tar on this machine: the pure-JS parser above already validated the format
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    expect(existsSync(join(dest, 'plugin', 'hooks', 'bb-hook.mjs'))).toBe(true);
    expect(existsSync(join(dest, '.claude-plugin', 'marketplace.json'))).toBe(true);
  });
});

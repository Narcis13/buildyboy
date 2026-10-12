import { arch, hostname, userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { writeClientConfig, bbHome } from './config.ts';

function platform(): string {
  if (process.platform === 'linux') {
    try {
      if (/microsoft/i.test(readFileSync('/proc/version', 'utf8'))) return 'wsl';
    } catch {
      // ignore
    }
  }
  return process.platform;
}

/** bb pair <url> <code> [name]: exchanges a pairing code for a machine token and writes ~/.buildyboy/config.json. */
export async function pairMachine(args: string[]) {
  const [url, code, name] = args;
  if (!url || !code) {
    console.error('usage: bb pair <server-url> <PAIRCODE> [machine-name]');
    process.exit(1);
  }
  const base = url.replace(/\/$/, '');
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: name ?? `${hostname()}${platform() === 'wsl' ? '-wsl' : ''}`, hostname: hostname(), platform: platform(), arch: arch(), user: userInfo().username }),
  });
  const body = (await res.json().catch(() => ({}))) as { machineId?: string; token?: string; error?: string };
  if (!res.ok || !body.token || !body.machineId) {
    console.error(`pairing failed: ${body.error ?? res.status}`);
    process.exit(1);
  }
  writeClientConfig({ url: base, token: body.token, machineId: body.machineId, name });
  console.log(`paired as ${body.machineId}; config written to ${bbHome()}/config.json`);
}

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bbHome, readClientConfig } from './config.ts';

/** bb doctor: config, reachability, token validity, spool and breaker state. Returns an exit code. */
export async function doctor(): Promise<number> {
  const cfg = readClientConfig();
  const home = bbHome();
  let ok = true;
  const line = (good: boolean, msg: string) => {
    if (!good) ok = false;
    console.log(`${good ? '✔' : '✘'} ${msg}`);
  };
  line(!!cfg.url && !!cfg.token, `config: ${join(home, 'config.json')} ${cfg.url ? `(server ${cfg.url})` : '(missing url/token — run bb pair)'}`);
  if (cfg.url) {
    try {
      const h = await fetch(`${cfg.url}/api/health`, { signal: AbortSignal.timeout(3000) });
      line(h.ok, `server reachable (${h.status})`);
      const r = await fetch(`${cfg.url}/api/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ envelopes: [] }),
        signal: AbortSignal.timeout(3000),
      });
      line(r.ok, `machine token ${r.ok ? 'accepted' : `rejected (${r.status})`}`);
    } catch (e) {
      line(false, `server unreachable: ${(e as Error).message}`);
    }
  }
  const spool = join(home, 'spool.jsonl');
  const size = existsSync(spool) ? statSync(spool).size : 0;
  console.log(`  spool: ${size} bytes`);
  const breaker = join(home, 'breaker');
  if (existsSync(breaker) && Date.now() - statSync(breaker).mtimeMs < 60_000) console.log('  circuit breaker: open (a recent call failed)');
  return ok ? 0 : 1;
}

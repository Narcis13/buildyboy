// Replays the synthetic fixture scenario into a running Buildyboy server.
//   npm run simulate -- [--url http://127.0.0.1:7700] [--data ./data] [--live] [--speed 1]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DB } from '../server/db.ts';
import { createMachine, sha256 } from '../server/auth.ts';
import type { Ctx } from '../server/context.ts';
import { buildScenario, MACHINES, scenarioStart, type MachineKey } from '../fixtures/scenario.ts';

export async function simulate(opts: { url: string; dataDir: string; live?: boolean; speed?: number; log?: (s: string) => void }) {
  const log = opts.log ?? console.log;
  const tokens = machineTokens(opts.dataDir);
  const t0 = opts.live ? Date.now() : scenarioStart();
  const { steps } = buildScenario(t0);
  const started = Date.now();
  for (const s of steps) {
    if (opts.live) {
      const wait = s.at / (opts.speed ?? 1) - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      s.envelope.ts = Date.now();
    }
    const tok = tokens[s.machine];
    const res = await fetch(`${opts.url}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.token}` },
      body: JSON.stringify({ envelopes: [{ ...s.envelope, machineId: tok.id }] }),
    });
    if (!res.ok) throw new Error(`ingest failed: ${res.status} ${await res.text()}`);
    if (opts.live) log(`${s.envelope.event.hook_event_name} ${s.envelope.event.tool_name ?? ''} (${s.envelope.event.session_id.slice(0, 8)})`);
  }
  log(`simulate: replayed ${steps.length} events for 3 sessions on 2 machines`);
  return tokens;
}

/** Reuses the simulator's machine tokens across runs (stored next to the DB). */
export function machineTokens(dataDir: string): Record<MachineKey, { id: string; token: string }> {
  const file = join(dataDir, 'simulate-tokens.json');
  const db = new DB(join(dataDir, 'buildyboy.db'));
  try {
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const out = {} as Record<MachineKey, { id: string; token: string }>;
    for (const key of Object.keys(MACHINES) as MachineKey[]) {
      const t = saved[key];
      if (t && db.get('SELECT 1 FROM machines WHERE id = ? AND token_hash = ? AND revoked = 0', t.id, sha256(t.token))) {
        out[key] = t;
        continue;
      }
      const m = MACHINES[key];
      out[key] = createMachine({ db } as Ctx, m.name, { hostname: m.hostname, platform: m.platform, user: m.user });
    }
    writeFileSync(file, JSON.stringify(out, null, 2));
    return out;
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith('simulate.ts')) {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: process.env.BUILDYBOY_URL ?? 'http://127.0.0.1:7700' },
      data: { type: 'string', default: process.env.BUILDYBOY_DATA ?? 'data' },
      live: { type: 'boolean', default: false },
      speed: { type: 'string', default: '1' },
    },
  });
  await simulate({ url: values.url!.replace(/\/$/, ''), dataDir: resolve(values.data!), live: values.live, speed: Number(values.speed) });
}

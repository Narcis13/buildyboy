// Synthetic factory data for the e2e suite and `npm run simulate`: a small backlog across all six statuses, gate results
// (with generated PNG screenshots) for one package, an open stop request, and one pending and one answered decision.
// It writes straight into the server's database with the same functions the API uses, so it needs no agent token.
// The server is running at the same time (WAL mode), exactly as with the simulator's machine tokens.
import { deflateSync, crc32 } from 'node:zlib';
import { configFromEnv, createContext } from '../server/main.ts';
import { createTask, recordGate, requestControl, updateTask, listTasks } from '../server/factory/tasks.ts';
import { answerDecision, askDecision } from '../server/factory/decisions.ts';
import { S1 } from './scenario.ts';

const ACTOR = 'agent:coordinator';

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([head, body, tail]);
}

/** A small PNG built in code: a flat background with a lighter title bar and a few "content" blocks, so it looks like a screen. */
export function samplePng(width: number, height: number, bg: [number, number, number]): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // filter byte 0 + RGB
    for (let x = 0; x < width; x++) {
      let [r, g, b] = bg;
      if (y < height * 0.12) [r, g, b] = [Math.min(255, r + 50), Math.min(255, g + 50), Math.min(255, b + 50)];
      else if (y > height * 0.3 && y < height * 0.45 && x > width * 0.1 && x < width * 0.8) [r, g, b] = [230, 236, 244];
      else if (y > height * 0.55 && y < height * 0.85 && x > width * 0.1 && x < width * 0.45) [r, g, b] = [92, 200, 255];
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

export interface FactorySeedOptions {
  url: string;
  dataDir: string;
  log?: (s: string) => void;
}

/** Idempotent: does nothing when the P-series packages are already there. */
export function seedFactory(opts: FactorySeedOptions): void {
  const log = opts.log ?? console.log;
  const ctx = createContext(configFromEnv({ dataDir: opts.dataDir, publicUrl: opts.url }));
  try {
    if (listTasks(ctx, { q: 'Customer accounts' }).length) {
      log('factory fixtures: already present');
      return;
    }
    const mk = (t: Parameters<typeof createTask>[1]) => createTask(ctx, { source: 'fixture', ...t }, ACTOR);

    mk({ id: 'P1', title: 'Project scaffold and CI', status: 'integrata', priority: 100, acceptance: ['The build runs in CI', 'Lint and typecheck pass'], body: 'Repository layout, the CI workflow and the shared lint setup.' });
    mk({ id: 'P2', title: 'Customer accounts', status: 'integrata', priority: 90, dependsOn: ['P1'], acceptance: ['Customers can be created and edited', 'Duplicate emails are rejected'], body: 'Customer records with validation.' });
    mk({
      id: 'P3',
      title: 'Stock movements',
      status: 'in_lucru',
      priority: 80,
      dependsOn: ['P1', 'P2'],
      branch: 'pachet/P3',
      sensitive: true,
      body: 'Receipts, issues and transfers between locations.\n\nEvery movement posts to the ledger in the same transaction.',
      acceptance: ['Stock moves post to the ledger', 'A negative balance is refused', 'Movements can be listed per location'],
    });
    mk({
      id: 'P4',
      title: 'Invoice export',
      status: 'la_porti',
      priority: 70,
      dependsOn: ['P2'],
      branch: 'pachet/P4',
      body: 'Export invoices as CSV and PDF.\n\nThe export page must work on a phone.',
      acceptance: ['CSV export matches the on-screen totals', 'PDF export opens on a phone', 'Exports are limited to the signed-in tenant'],
    });
    mk({ id: 'P5', title: 'Reporting dashboard', status: 'gata', priority: 60, dependsOn: ['P2'], body: 'Monthly totals and a trend chart.', acceptance: ['Totals match the ledger'] });
    mk({ id: 'P6', title: 'Mobile layout polish', status: 'gata', priority: 50, dependsOn: ['P3'], acceptance: ['No horizontal scroll at 390 px'] });
    mk({ id: 'P7', title: 'Audit log retention', status: 'backlog', priority: 40, body: 'Purge audit rows older than the retention setting.' });
    mk({ id: 'P8', title: 'Payment gateway sandbox', status: 'blocata', priority: 30, dependsOn: ['P3'], body: 'Blocked on a decision about the sandbox account.' });

    updateTask(ctx, { id: 'P1', costUsd: 3.2 }, ACTOR);
    updateTask(ctx, { id: 'P2', costUsd: 5.75 }, ACTOR);
    updateTask(ctx, { id: 'P3', costUsd: 8.4, terminal: 'term-2', sessionId: S1, note: 'Ledger posting is wired; location lists next.' }, ACTOR, { claimedBy: 'agent:coordinator' });
    updateTask(ctx, { id: 'P4', costUsd: 6.1 }, ACTOR, { claimedBy: 'agent:coordinator' });

    // gates for P4: G3 failed first, then passed; G4 carries two screenshots; G5 has no result yet
    const shot = (name: string, w: number, h: number, bg: [number, number, number]) => ({ name, mime: 'image/png', base64: samplePng(w, h, bg).toString('base64') });
    recordGate(ctx, { taskId: 'P4', gate: 'G1', verdict: 'pass', summary: 'Typecheck, lint, 212 unit tests and 18 e2e tests pass.' }, ACTOR);
    recordGate(ctx, { taskId: 'P4', gate: 'G2', verdict: 'pass', summary: 'All three acceptance checks pass.' }, ACTOR);
    recordGate(ctx, { taskId: 'P4', gate: 'G3', verdict: 'fail', summary: 'The export query is not scoped to the tenant.' }, ACTOR);
    recordGate(ctx, { taskId: 'P4', gate: 'G3', verdict: 'pass', summary: 'Tenant scoping fixed; no other findings.' }, ACTOR);
    recordGate(
      ctx,
      {
        taskId: 'P4',
        gate: 'G4',
        verdict: 'pass',
        summary: 'Export page checked at 1280x800 and 390x844.',
        screenshots: [shot('export-desktop.png', 320, 200, [17, 37, 63]), shot('export-phone.png', 100, 200, [22, 48, 82])],
      },
      ACTOR,
    );

    requestControl(ctx, 'P3', 'stop', 'Hold until the ledger design is confirmed.', 'web');

    askDecision(
      ctx,
      {
        taskId: 'P3',
        question: 'Which rounding rule should stock valuation use?',
        context: 'Valuation multiplies quantity by unit cost.\nThe ledger stores amounts with 2 decimals.\n\nBanker’s rounding avoids a systematic bias; round half up matches the old spreadsheet.',
        options: ['Round half up', 'Banker’s rounding'],
      },
      ACTOR,
    );
    const old = askDecision(ctx, { taskId: 'P2', question: 'Keep the legacy customer export format?', options: ['Keep it', 'Drop it'] }, ACTOR);
    answerDecision(ctx, old.id, 'Keep it for one more release', 'web');

    log('factory fixtures: 8 packages, gates for P4, 1 stop request, 2 decisions');
  } finally {
    ctx.db.close();
  }
}

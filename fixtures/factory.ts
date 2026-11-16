// Synthetic factory data for the e2e suite and `npm run simulate`: a small backlog across all six statuses, gate results
// (with generated PNG screenshots) for one package, an open stop request, and one pending and one answered decision;
// then two factory projects (SPEC §12.1) on the simulator's checkouts: shop-api (id prefix SH-, autopilot on, packages on
// the line, an archive) and billing (paused, legacy §11.7 allocation fields, a blocked package, an archive). The P-series
// has no project. The checkout example/notes stays without one ("Other repositories").
// It writes straight into the server's database with the same functions the API uses, so it needs no agent token.
// The server is running at the same time (WAL mode), exactly as with the simulator's machine tokens.
import { deflateSync, crc32 } from 'node:zlib';
import { configFromEnv, createContext } from '../server/main.ts';
import { createTask, recordGate, requestControl, updateTask, listTasks } from '../server/factory/tasks.ts';
import { answerDecision, askDecision } from '../server/factory/decisions.ts';
import { createProject, projectAction, projectRow, storeProjectLine } from '../server/factory/projects.ts';
import { resolveLine } from '../shared/line.ts';
import type { Ctx } from '../server/context.ts';
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

/** Idempotent: each part does nothing when it is already there. */
export function seedFactory(opts: FactorySeedOptions): void {
  const log = opts.log ?? console.log;
  const ctx = createContext(configFromEnv({ dataDir: opts.dataDir, publicUrl: opts.url }));
  try {
    if (listTasks(ctx, { q: 'Customer accounts', archived: 'all' }).length) log('factory fixtures: packages already present');
    else seedPackages(ctx, log);
    if (projectRow(ctx, 'shop-api')) log('factory fixtures: projects already present');
    else seedProjects(ctx, log);
  } finally {
    ctx.db.close();
  }
}

function seedPackages(ctx: Ctx, log: (s: string) => void) {
  {
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
  }
}

const HOUR = 3600_000;

/** What only days of work on the line would set: when it was created and integrated, how many rounds it took. */
function backdate(ctx: Ctx, id: string, f: { integratedHoursAgo?: number; round?: number; createdHoursAgo?: number }) {
  const now = Date.now();
  if (f.integratedHoursAgo != null) ctx.db.run('UPDATE tasks SET integrated_at = ? WHERE id = ?', now - f.integratedHoursAgo * HOUR, id);
  if (f.createdHoursAgo != null) ctx.db.run('UPDATE tasks SET created_at = ? WHERE id = ?', now - f.createdHoursAgo * HOUR, id);
  if (f.round != null) ctx.db.run('UPDATE tasks SET round = ? WHERE id = ?', f.round, id);
}

function seedProjects(ctx: Ctx, log: (s: string) => void) {
  const machine = (name: string) => ctx.db.get<{ id: string }>('SELECT id FROM machines WHERE name = ? AND revoked = 0 ORDER BY first_seen LIMIT 1', name)?.id ?? null;

  // shop-api: id prefix SH-, autopilot on, two packages on the line, one ready, an archive of two
  createProject(
    ctx,
    {
      key: 'shop-api', name: 'Shop API', repo: 'example/shop-api', idPrefix: 'SH-', machineId: machine('devbox-win'), checkout: 'C:\\work\\shop-api', lineFile: 'factory.json',
      config: { limits: { workers: 2, rounds: 4 }, models: { review: 'opus', visual: 'sonnet' }, integrate: { approval: 'sensitive' } },
    },
    'web',
  );
  const sh = (t: Parameters<typeof createTask>[1]) => createTask(ctx, { source: 'fixture', project: 'shop-api', ...t }, ACTOR);
  sh({ id: '1', title: 'Login form', status: 'integrata', priority: 100, acceptance: ['The form signs a customer in'] });
  sh({ id: '2', title: 'Rate limiting on /login', status: 'integrata', priority: 95, dependsOn: ['1'], sensitive: true, acceptance: ['Ten failed attempts lock the account for 15 minutes'] });
  sh({ id: '3', title: 'Password reset by email', status: 'integrata', priority: 90, dependsOn: ['1'], acceptance: ['A reset link expires after one hour'] });
  sh({ id: '4', title: 'Session expiry banner', status: 'in_lucru', priority: 80, dependsOn: ['1'], branch: 'pkg/SH-4', acceptance: ['The banner shows two minutes before expiry'] });
  sh({ id: '5', title: 'Two-factor sign-in', status: 'la_porti', priority: 70, dependsOn: ['1'], branch: 'pkg/SH-5', sensitive: true, acceptance: ['A TOTP code is asked after the password'] });
  sh({ id: '6', title: 'Login audit trail', status: 'gata', priority: 60, dependsOn: ['3'], acceptance: ['Every sign-in is logged with its IP'] });
  sh({ id: '7', title: 'Remember-me cookie', status: 'backlog', priority: 50 });
  updateTask(ctx, { id: 'SH-1', costUsd: 2.4 }, ACTOR);
  updateTask(ctx, { id: 'SH-2', costUsd: 4.15 }, ACTOR);
  updateTask(ctx, { id: 'SH-3', costUsd: 3.05 }, ACTOR);
  updateTask(ctx, { id: 'SH-4', costUsd: 1.9, sessionId: S1, terminal: 'bb-SH-4' }, ACTOR, { claimedBy: 'factory:line' });
  updateTask(ctx, { id: 'SH-5', costUsd: 5.3 }, ACTOR, { claimedBy: 'factory:line' });
  backdate(ctx, 'SH-1', { createdHoursAgo: 120, integratedHoursAgo: 96, round: 1 });
  backdate(ctx, 'SH-2', { createdHoursAgo: 100, integratedHoursAgo: 50, round: 2 });
  backdate(ctx, 'SH-3', { createdHoursAgo: 30, integratedHoursAgo: 3, round: 1 });
  backdate(ctx, 'SH-5', { round: 1 });
  updateTask(ctx, { id: 'SH-1', archived: true }, 'factory:archive');
  updateTask(ctx, { id: 'SH-2', archived: true }, 'factory:archive');
  recordGate(ctx, { taskId: 'SH-5', gate: 'G1', verdict: 'pass', summary: 'Typecheck, lint and 140 tests pass.' }, ACTOR);
  recordGate(ctx, { taskId: 'SH-5', gate: 'G2', verdict: 'pass', summary: 'The acceptance test passes.' }, ACTOR);
  recordGate(ctx, { taskId: 'SH-5', gate: 'G3', verdict: 'fail', summary: 'The TOTP secret is logged at debug level.' }, ACTOR);
  askDecision(ctx, { taskId: 'SH-5', question: 'Require two-factor sign-in for every customer, or only for admins?', options: ['Only admins', 'Every customer'] }, 'factory:line');
  projectAction(ctx, 'shop-api', 'autopilot', 'web', { on: true });

  // the line the runner reported for shop-api (§12.3): G4 is off, so its stepper has no G4. Its runner is offline in the
  // e2e run, so the conductor (autopilot on) holds the project and leaves the state below alone.
  const line = resolveLine(
    { commands: { verify: 'npm test', acceptance: 'npm run acceptance', shots: 'npm run shots' }, gates: { G4: { enabled: false } } },
    { checkoutDir: 'C:\\work\\shop-api', file: 'factory.json' },
  );
  if (!line.ok) throw new Error(`fixture line does not resolve: ${line.errors.join('; ')}`);
  storeProjectLine(ctx, 'shop-api', line.line, null);
  // SH-4 is on the line for real: a stage and what the conductor waits for (SPEC §12.5), with its history
  const ago = (min: number) => Date.now() - min * 60_000;
  ctx.db.run('UPDATE tasks SET stage = ?, line_json = ? WHERE id = ?', 'build', JSON.stringify({ waiting: "the worker's turn to end", since: ago(7), status: 'in_lucru', attempts: 0 }), 'SH-4');
  const lineEvent = (min: number, kind: string, detail: unknown) =>
    ctx.db.run('INSERT INTO task_events (task_id, ts, actor, kind, from_status, to_status, detail_json) VALUES (?, ?, ?, ?, NULL, NULL, ?)', 'SH-4', ago(min), 'factory:line', kind, JSON.stringify(detail));
  lineEvent(14, 'line', { text: 'Claimed SH-4: port 4101 and database shop_sh4 allocated. Next: prepare.', stage: 'prepare', waiting: 'the prepare step' });
  lineEvent(12, 'step_run', { runId: 'r1', step: 'prepare', round: 1 });
  lineEvent(11, 'step', { runId: 'r1', step: 'prepare', verdict: 'pass', summary: 'worktree ready' });
  lineEvent(9, 'line', { text: 'Prepared SH-4. Next: build (the worker starts in terminal bb-SH-4).', stage: 'build', waiting: 'the worker to start' });
  lineEvent(7, 'line', { text: "The worker started in terminal bb-SH-4. Waiting for its turn to end.", stage: 'build', waiting: "the worker's turn to end" });
  // a plan that failed (the planner's job is gone), so the Line tab's Plans list shows one
  ctx.db.run(
    "INSERT INTO plans (id, project, goal, status, error, questions_json, actor, created_at, updated_at) VALUES (?, ?, ?, 'failed', ?, ?, 'web', ?, ?)",
    'plan-fixture-failed', 'shop-api', 'Let customers manage their saved payment methods', 'the planner could not read the checkout', JSON.stringify(['Which payment provider does the shop use?']), ago(180), ago(170),
  );

  // billing: paused, migrated from §11.7 (legacy allocation fields), one blocked package, an archive of two
  createProject(
    ctx,
    {
      key: 'billing', name: 'Billing', repo: 'example/billing', idPrefix: '', machineId: machine('devbox-win'), checkout: 'C:\\work\\billing', lineFile: 'fabrica/porti/porti.json',
      config: { legacy: { worktree: 'C:\\work\\billing-wt\\{idLower}', portFrom: 4100, portTo: 4199, dbPrefix: 'bill_', migrationFrom: 200, migrationBlock: 10, cleanup: ['dropdb {db}'] } },
    },
    'web',
  );
  const bi = (t: Parameters<typeof createTask>[1]) => createTask(ctx, { source: 'fixture', project: 'billing', ...t }, ACTOR);
  bi({ id: 'B1', title: 'Numbering of issued documents', status: 'integrata', priority: 90 });
  bi({ id: 'B2', title: 'VAT rounding per line', status: 'integrata', priority: 80, dependsOn: ['B1'] });
  bi({ id: 'B3', title: 'Credit notes', status: 'blocata', priority: 70, dependsOn: ['B1'], body: 'Blocked: the accountant has to confirm the numbering series.' });
  bi({ id: 'B4', title: 'Dunning emails', status: 'gata', priority: 60, dependsOn: ['B2'] });
  updateTask(ctx, { id: 'B1', costUsd: 6.2 }, ACTOR);
  updateTask(ctx, { id: 'B2', costUsd: 3.8 }, ACTOR);
  backdate(ctx, 'B1', { createdHoursAgo: 400, integratedHoursAgo: 340, round: 3 });
  backdate(ctx, 'B2', { createdHoursAgo: 300, integratedHoursAgo: 260, round: 1 });
  updateTask(ctx, { id: 'B1', archived: true }, 'factory:archive');
  updateTask(ctx, { id: 'B2', archived: true }, 'factory:archive');
  projectAction(ctx, 'billing', 'pause', 'web');

  log('factory fixtures: projects shop-api (7 packages, autopilot on) and billing (paused, 4 packages)');
}

// Regenerates the app screenshots in the user manual (server/docs/assets/img) from the synthetic fixtures.
//   node scripts/docs-screenshots.ts            (needs `npm run build` first; uses Playwright's Chromium, or Chrome)
// It boots a throwaway server exactly like the e2e suite, replays the fixtures, parks a few real hook calls in the
// Inbox, and photographs each screen at desktop (1280×800) and phone (390×844) sizes.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import globalSetup from '../e2e/global-setup.ts';
import { machineTokens } from './simulate.ts';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'server', 'docs', 'assets', 'img');
const HOOK = join(ROOT, 'plugin', 'hooks', 'bb-hook.mjs');

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ channel: 'chrome' }); // no Playwright browser downloaded: use the installed Chrome
  }
}

/** Starts bb-hook.mjs as Claude Code would and leaves it waiting on the server (a card in the Inbox). */
function parkHook(input: Record<string, unknown>, args = ['--control']): ChildProcess {
  const a = machineTokens(process.env.BB_E2E_DATA!).A;
  const p = spawn(process.execPath, [HOOK, ...args], {
    env: { ...process.env, BUILDYBOY_URL: process.env.BB_E2E_URL, BUILDYBOY_TOKEN: a.token, BUILDYBOY_HOME: mkdtempSync(join(tmpdir(), 'bb-docs-home-')) },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  p.stdin!.end(JSON.stringify(input));
  return p;
}

function runHook(input: Record<string, unknown>, args: string[] = []): Promise<void> {
  return new Promise((resolve) => parkHook(input, args).on('close', () => resolve()));
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Password').fill(process.env.BB_E2E_PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('button', { name: 'Log in' }).waitFor({ state: 'detached' });
}

async function csrf(page: Page) {
  return (await page.context().cookies()).find((c) => c.name === 'bb_csrf')?.value ?? '';
}

async function shot(page: Page, name: string, path: string, ready?: (p: Page) => Promise<unknown>) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  if (ready) await ready(page);
  await page.waitForTimeout(600); // let entrance animations settle
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ${name}.png`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  process.env.BUILDYBOY_PUBLIC_URL = 'https://buildyboy.example.com'; // what the pairing dialog prints
  const teardown = await globalSetup();
  const parked: ChildProcess[] = [];
  const browser = await launch();
  try {
    const url = process.env.BB_E2E_URL!;
    const desktop = await browser.newContext({ baseURL: url, viewport: DESKTOP, colorScheme: 'dark' });
    const phone = await browser.newContext({ baseURL: url, viewport: PHONE, colorScheme: 'dark', hasTouch: true });
    const d = await desktop.newPage();
    const p = await phone.newPage();

    // The setup screen, before anyone logs in.
    await shot(p, 'login-phone', '/login');
    await login(d);
    await login(p);

    // Walk mode on, and four kinds of request waiting in the Inbox.
    await d.request.post('/api/global/walk', { data: { on: true }, headers: { 'x-bb-csrf': await csrf(d) } });
    const base = { session_id: 'docs-walk-demo', cwd: 'C:\\work\\shop-api', transcript_path: 'C:\\nowhere.jsonl', permission_mode: 'default' };
    await runHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
    await runHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Fix the flaky checkout test and make the build green' }, ['--control']);
    parked.push(
      parkHook({
        ...base,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Edit',
        tool_input: { file_path: 'C:\\work\\shop-api\\src\\checkout.ts', old_string: '  await sleep(500);\n  return cart.total;', new_string: '  await cart.ready();\n  return cart.total;' },
      }),
      parkHook({
        ...base,
        session_id: 'docs-walk-plan',
        hook_event_name: 'PermissionRequest',
        tool_name: 'ExitPlanMode',
        tool_input: { plan: '## Plan\n\n1. Reproduce the flake by running the checkout test 20 times.\n2. Replace the fixed `sleep(500)` with `await cart.ready()`.\n3. Run the full suite, then commit on `fix/checkout-flake`.' },
      }),
    );
    await d.waitForTimeout(800);

    await shot(d, 'floor-desktop', '/');
    await shot(p, 'floor-phone', '/');
    await shot(d, 'inbox-desktop', '/inbox', (pg) => pg.getByTestId('inbox-card').first().waitFor());
    await shot(p, 'inbox-phone', '/inbox', (pg) => pg.getByTestId('inbox-card').first().waitFor());

    // The busiest fixture session.
    const sessions = await d.request.get('/api/sessions').then((r) => r.json());
    const list: { id: string; costUsd?: number }[] = Array.isArray(sessions) ? sessions : (sessions.sessions ?? []);
    const busiest = [...list].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))[0];
    if (busiest) {
      await shot(d, 'session-desktop', `/s/${busiest.id}`);
      await shot(p, 'session-phone', `/s/${busiest.id}`);
    }

    await shot(d, 'composer-desktop', '/composer');
    await shot(d, 'jobs-launch-desktop', '/jobs?new=1');
    await shot(d, 'machines-desktop', '/machines');
    await shot(d, 'machines-pair-desktop', '/machines', async (pg) => {
      await pg.getByRole('button', { name: 'Pair a machine' }).click();
      await pg.getByRole('button', { name: 'Create pairing code' }).click();
      await pg.getByText('Expires in').waitFor();
    });
    await shot(d, 'settings-desktop', '/settings');
    await shot(d, 'insights-desktop', '/analytics');
    await shot(d, 'search-desktop', '/search?q=test');

    await d.request.post('/api/global/walk', { data: { on: false }, headers: { 'x-bb-csrf': await csrf(d) } });
  } finally {
    for (const c of parked) c.kill();
    await browser.close();
    await teardown();
  }
}

await main();

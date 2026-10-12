// Inbox, Machines, Settings, Projects, Analytics and Search on simulated data, at both viewports.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test as base, expect, trackConsoleErrors } from './fixtures.ts';
import { machineTokens } from '../scripts/simulate.ts';
// a session of its own, so the shared fixture sessions (S2 is "waiting") stay untouched for the other specs
const INBOX_SID = '44444444-4444-4444-8444-444444444444';

let cookiePromise: Promise<{ name: string; value: string; url: string }[]> | null = null;

/** Logs in once per worker over the API (the login endpoint is rate limited to 10 attempts a minute), then every test just adds the cookies. */
function sessionCookies() {
  cookiePromise ??= (async () => {
    const url = process.env.BB_E2E_URL!;
    const res = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: process.env.BB_E2E_PASSWORD }) });
    if (!res.ok) throw new Error(`login failed: ${res.status}`);
    return res.headers.getSetCookie().map((c) => {
      const [name, ...rest] = c.split(';')[0].split('=');
      return { name, value: rest.join('='), url };
    });
  })();
  return cookiePromise;
}

const test = base.extend<{ loggedIn: Page }>({
  loggedIn: async ({ page, context }, use) => {
    await context.addCookies(await sessionCookies());
    await use(page);
  },
});

/** Set BB_SHOTS_DIR to save a full-page screenshot of every page. */
async function shot(page: Page, name: string) {
  const dir = process.env.BB_SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}-${test.info().project.name}.png`), fullPage: true });
}

async function noHorizontalScroll(page: Page) {
  const w = (await page.evaluate('({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })')) as { scroll: number; inner: number };
  expect(w.scroll, `page scrolls horizontally (${w.scroll} > ${w.inner})`).toBeLessThanOrEqual(w.inner);
}

/** Console errors that are not part of the test (aborted requests while navigating, expected 4xx). */
const real = (errors: string[]) => errors.filter((e) => !/401|Failed to load resource.*(40[0-9]|net::ERR_ABORTED)/.test(e));

/** POSTs a control event to the sync hook endpoint as the simulator's machine A; resolves with the hook's stdout JSON when answered. */
function hook(event: string, evt: Record<string, unknown>): Promise<string> {
  const a = machineTokens(process.env.BB_E2E_DATA!).A;
  return fetch(`${process.env.BB_E2E_URL}/api/hook/${event}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      v: 1, ts: Date.now(), machineId: a.id, env: {}, hostname: 'DEVBOX', platform: 'win32', user: 'dev', pid: 1, ppid: 1, hookVersion: '0.1.0',
      event: { session_id: INBOX_SID, hook_event_name: event, cwd: 'C:\\work\\billing', ...evt },
    }),
  }).then(async (r) => {
    const body = (await r.json()) as { output?: unknown };
    return JSON.stringify(body.output ?? body);
  });
}

async function setWalk(page: Page, on: boolean) {
  const res = await page.request.post('/api/global/walk', { data: { on }, headers: { 'x-bb-csrf': await csrf(page) } });
  expect(res.ok()).toBe(true);
}

async function csrf(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === 'bb_csrf')?.value ?? '';
}

test.describe('page smoke', () => {
  test('inbox', async ({ loggedIn: page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/inbox');
    await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
    await expect(page.getByTestId('global-controls')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Walk mode' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Pause everything' })).toBeVisible();
    await shot(page, 'inbox-empty');
    await noHorizontalScroll(page);
    expect(real(errors)).toEqual([]);
  });

  test('machines', async ({ loggedIn: page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/machines');
    await expect(page.getByTestId('machine-card')).toHaveCount(2);
    const win = page.getByTestId('machine-card').filter({ hasText: 'devbox-win' });
    await expect(win).toContainText('Windows');
    await expect(win).toContainText('0.1.0');
    await expect(page.getByTestId('machine-card').filter({ hasText: 'wsl-ubuntu' })).toContainText('WSL');
    await expect(page.getByTestId('hook-health')).toContainText('bb doctor');
    await shot(page, 'machines');
    await noHorizontalScroll(page);
    expect(real(errors)).toEqual([]);
  });

  test('machines: per-machine walk mode is tri-state', async ({ loggedIn: page }) => {
    await page.goto('/machines');
    const card = page.getByTestId('machine-card').filter({ hasText: 'wsl-ubuntu' });
    const group = card.getByTestId('machine-walk');
    await group.getByRole('radio', { name: 'On' }).click();
    await expect(group.getByRole('radio', { name: 'On' })).toHaveAttribute('aria-checked', 'true');
    await group.getByRole('radio', { name: 'Off' }).click();
    await expect(group.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true');
    await group.getByRole('radio', { name: 'Inherit' }).click();
    await expect(group.getByRole('radio', { name: 'Inherit' })).toHaveAttribute('aria-checked', 'true');
    // it persisted
    await page.reload();
    await expect(page.getByTestId('machine-card').filter({ hasText: 'wsl-ubuntu' }).getByRole('radio', { name: 'Inherit' })).toHaveAttribute('aria-checked', 'true');
  });

  test('machines: pairing code with countdown and install commands', async ({ loggedIn: page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/machines');
    await page.getByTestId('pair-open').click();
    await page.getByTestId('pair-name').fill('e2e-laptop');
    await page.getByTestId('pair-create').click();
    const code = (await page.getByTestId('pair-code').textContent())!.trim();
    expect(code.length).toBeGreaterThanOrEqual(6);
    await expect(page.getByTestId('pair-countdown')).toContainText(/Expires in (09|10):\d\d/);
    await expect(page.getByTestId('pair-bash')).toContainText(`install.sh | bash -s -- ${code}`);
    await expect(page.getByTestId('pair-powershell')).toContainText(`BB_CODE='${code}'`);
    await expect(page.getByTestId('pair-panel')).toContainText('separate');
    await shot(page, 'machines-pair');
    await noHorizontalScroll(page);
    expect(real(errors)).toEqual([]);
  });

  test('settings', async ({ loggedIn: page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    for (const id of ['settings-notifications', 'settings-limits', 'settings-github', 'settings-snippets', 'settings-redaction', 'settings-password', 'settings-devices']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    const otel = page.getByTestId('snippet-otel');
    for (const s of ['CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_METRICS_EXPORTER', 'OTEL_LOGS_EXPORTER', 'http/json', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'Bearer <machine token>', process.env.BB_E2E_URL!]) {
      await expect(otel).toContainText(s);
    }
    await expect(page.getByTestId('snippet-statusline')).toContainText('bb-statusline.mjs');
    await expect(page.getByTestId('device-row')).not.toHaveCount(0);
    await shot(page, 'settings');
    await noHorizontalScroll(page);
    expect(real(errors)).toEqual([]);
  });

  test('settings: limits, quiet hours and redaction rules save and reload', async ({ loggedIn: page }) => {
    await page.goto('/settings');
    // limits
    await page.getByLabel('Session budget (USD)').fill('7.5');
    await page.getByLabel('Context threshold (%)').fill('80');
    await page.getByTestId('limits-save').click();
    await expect(page.getByTestId('settings-limits').getByRole('status')).toHaveText('Saved');
    // notifications
    await page.getByRole('switch', { name: 'Quiet hours' }).click();
    await page.getByTestId('notifications-save').click();
    await expect(page.getByTestId('settings-notifications').getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    // redaction: add a rule, see it mask the sample
    await page.getByTestId('redaction-add').click();
    await page.getByLabel('Rule 1 name').fill('internal header');
    await page.getByLabel('Rule 1 pattern').fill('abc\\d+-secret');
    await expect(page.getByTestId('redaction-preview')).toContainText('[REDACTED]');
    await page.getByLabel('Rule 1 pattern').fill('(unclosed');
    await expect(page.getByTestId('settings-redaction')).toContainText('Invalid');
    await expect(page.getByTestId('redaction-save')).toBeDisabled();
    await page.getByLabel('Rule 1 pattern').fill('abc\\d+-secret');
    await page.getByTestId('redaction-save').click();
    await expect(page.getByTestId('settings-redaction').getByRole('status')).toHaveText('Saved');

    await page.reload();
    await expect(page.getByLabel('Session budget (USD)')).toHaveValue('7.5');
    await expect(page.getByLabel('Context threshold (%)')).toHaveValue('80');
    await expect(page.getByRole('switch', { name: 'Quiet hours' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('Rule 1 name')).toHaveValue('internal header');

    // clean up so the shared server is back to defaults
    await page.getByLabel('Session budget (USD)').fill('');
    await page.getByLabel('Context threshold (%)').fill('');
    await page.getByTestId('limits-save').click();
    await expect(page.getByTestId('settings-limits').getByRole('status')).toHaveText('Saved');
    await page.getByRole('switch', { name: 'Quiet hours' }).click();
    await page.getByTestId('notifications-save').click();
    await page.getByTestId('settings-redaction').getByRole('button', { name: 'Remove' }).click();
    await page.getByTestId('redaction-save').click();
    await expect(page.getByTestId('settings-redaction').getByRole('status')).toHaveText('Saved');
    const s = await (await page.request.get('/api/settings')).json();
    expect(s.budget_session_usd).toBeNull();
    expect(s.redaction_rules).toEqual([]);
  });

  test('settings: password change rejects a wrong current password; test notification answers', async ({ loggedIn: page }) => {
    await page.goto('/settings');
    await page.getByLabel('Current password', { exact: true }).fill('not-the-password');
    await page.getByLabel('New password', { exact: true }).fill('another-password-1');
    await page.getByLabel('New password again').fill('another-password-1');
    await page.getByTestId('password-save').click();
    await expect(page.getByTestId('settings-password').getByRole('alert')).toContainText('wrong password');
    await page.getByTestId('push-test').click();
    await expect(page.getByTestId('push-test-result')).toContainText('Sent to');
  });

  test('projects list and detail', async ({ loggedIn: page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/projects');
    await expect(page.getByTestId('project-card')).toHaveCount(3);
    await shot(page, 'projects');
    await noHorizontalScroll(page);
    await page.getByTestId('project-card').filter({ hasText: 'shop-api' }).click();
    await expect(page).toHaveURL(/\/projects\/\d+$/);
    await expect(page.getByRole('heading', { name: 'shop-api' })).toBeVisible();
    await expect(page.getByTestId('project-sessions')).toContainText('Add rate limiting to login');
    await expect(page.getByTestId('project-commits')).toContainText('Add login rate limiting');
    await expect(page.getByTestId('project-progress')).toContainText('Open the PR');
    await expect(page.getByTestId('project-cost-chart').locator('svg')).toBeVisible();
    await shot(page, 'project-detail');
    await noHorizontalScroll(page);
    expect(real(errors)).toEqual([]);
  });

  test('analytics', async ({ loggedIn: page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/analytics');
    await expect(page.getByTestId('analytics-totals')).toBeVisible();
    await expect(page.getByTestId('analytics-totals')).toContainText(/[3-9] sessions/);
    await expect(page.getByTestId('chart-cost').locator('svg')).toBeVisible();
    await expect(page.getByTestId('analytics-tools')).toContainText('Bash');
    await expect(page.getByTestId('analytics-failed')).toContainText('npm test');
    await expect(page.getByTestId('analytics-rate')).toContainText('statusline');
    await shot(page, 'analytics');
    await page.getByRole('tab', { name: '7 days' }).click();
    await expect(page.getByTestId('chart-cost').locator('svg rect').first()).toBeVisible();
    await page.getByRole('tab', { name: 'Model' }).click();
    await expect(page.getByTestId('analytics-cost')).toContainText('claude');
    await page.getByRole('tab', { name: 'Machine' }).click();
    await expect(page.getByTestId('analytics-cost')).toContainText('devbox-win');
    await noHorizontalScroll(page);
    expect(real(errors)).toEqual([]);
  });

  test('search finds commands and deep-links to the session', async ({ loggedIn: page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/search');
    await expect(page.getByTestId('search-input')).toBeVisible();
    await page.getByTestId('search-input').fill('rate limit');
    await expect(page.getByTestId('search-hit').first()).toBeVisible();
    await expect(page.getByTestId('search-results').locator('mark').first()).toBeVisible();
    await shot(page, 'search');
    await noHorizontalScroll(page);
    await page.getByTestId('search-input').fill('npm update');
    const hit = page.getByTestId('search-hit').first();
    await expect(hit).toContainText('npm');
    await hit.locator('a').click();
    await expect(page).toHaveURL(/\/s\/[0-9a-f-]+#toolu_/);
    expect(real(errors)).toEqual([]);
  });
});

test.describe('inbox flow', () => {
  test.afterEach(async ({ page }) => {
    // both projects share one server: leave walk mode off
    try {
      await setWalk(page, false);
    } catch {
      // not logged in
    }
  });

  test('walk mode on, permission shows up, Allow once reaches the hook', async ({ loggedIn: page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/inbox');
    const walk = page.getByRole('switch', { name: 'Walk mode' });
    await walk.click();
    await expect(walk).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await (await page.request.get('/api/global')).json()).walk).toBe(true);

    const pending = hook('PermissionRequest', {
      tool_name: 'Bash',
      tool_input: { command: 'npm run deploy', description: 'Deploy to production' },
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run deploy' }], behavior: 'allow', destination: 'localSettings' }],
    });
    const card = page.getByTestId('inbox-card').filter({ hasText: 'npm run deploy' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Bash');
    await expect(card).toContainText('billing');
    await expect(card).toContainText('C:\\work\\billing');
    await expect(card.getByTestId('answer-allow-session')).toBeVisible();
    await expect(page.getByTestId('inbox-count')).toContainText('1 waiting');
    await shot(page, 'inbox-permission');
    await noHorizontalScroll(page);

    // touch targets: the answer buttons are at least 44px tall
    for (const id of ['answer-allow', 'answer-allow-session', 'answer-deny', 'answer-deny-interrupt']) {
      const box = await card.getByTestId(id).boundingBox();
      expect(box!.height, id).toBeGreaterThanOrEqual(44);
    }

    await card.getByTestId('answer-allow').click();
    expect(await pending).toContain('"behavior":"allow"');
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('inbox-history').getByTestId('history-row').first()).toContainText('Allowed once');
    expect(real(errors)).toEqual([]);
  });

  test('Deny and interrupt carries the message', async ({ loggedIn: page }) => {
    await setWalk(page, true);
    await page.goto('/inbox');
    const pending = hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/e2e-danger' } });
    const card = page.getByTestId('inbox-card').filter({ hasText: 'rm -rf /tmp/e2e-danger' });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('answer-allow-session')).toHaveCount(0); // no permission suggestions
    await card.getByTestId('deny-message').fill('Not that, use the dry run');
    await card.getByTestId('answer-deny-interrupt').click();
    const out = await pending;
    expect(out).toContain('"behavior":"deny"');
    expect(out).toContain('Not that, use the dry run');
    expect(out).toContain('"interrupt":true');
  });

  test('question, plan and stop-wait cards can each be answered', async ({ loggedIn: page }) => {
    await setWalk(page, true);
    await page.goto('/inbox');

    // a multiple-choice question with a multi-select
    const q1 = 'Which environments should it deploy to?';
    const q2 = 'Use the old config?';
    const question = hook('PermissionRequest', {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { question: q1, header: 'Env', multiSelect: true, options: [{ label: 'staging', description: 'Safe' }, { label: 'prod', description: 'Real users' }] },
          { question: q2, header: 'Config', multiSelect: false, options: [{ label: 'Yes', description: 'Keep' }, { label: 'No', description: 'Drop' }] },
        ],
      },
    });
    const qCard = page.getByTestId('inbox-card').filter({ hasText: q1 });
    await expect(qCard).toBeVisible();
    await expect(qCard.getByTestId('answer-submit')).toBeDisabled();

    // a plan
    const plan = hook('PermissionRequest', { tool_name: 'ExitPlanMode', tool_input: { plan: '## Plan\n\n1. Add the **deploy** script\n2. Run it' } });
    const pCard = page.getByTestId('inbox-card').filter({ hasText: 'Add the deploy script' });
    await expect(pCard).toBeVisible();
    await expect(pCard.locator('strong')).toHaveText('deploy');

    await shot(page, 'inbox-question-plan');
    await noHorizontalScroll(page);

    // answer the question: tick staging + type an "Other", pick "No"
    await qCard.getByRole('checkbox', { name: 'staging' }).click();
    await qCard.getByTestId('question-other').first().click();
    await qCard.getByTestId('question-other-text').fill('canary');
    await qCard.getByRole('radio', { name: /^No/ }).click();
    await expect(qCard.getByTestId('answer-submit')).toBeEnabled();
    await qCard.getByTestId('answer-submit').click();
    const answered = await question;
    expect(answered).toContain('"behavior":"allow"');
    expect(answered).toContain(`"${q1}":"staging, canary"`);
    expect(answered).toContain(`"${q2}":"No"`);

    // reject the plan with feedback
    await pCard.getByTestId('plan-feedback').fill('Add a rollback step');
    await pCard.getByTestId('answer-reject').click();
    const rejected = await plan;
    expect(rejected).toContain('"behavior":"deny"');
    expect(rejected).toContain('Add a rollback step');

    // a finished turn (a Stop event also supersedes older pending items, so it comes last)
    const stop = hook('Stop', { last_assistant_message: 'Finished the **billing** export refactor. Want me to run the tests?' });
    const sCard = page.getByTestId('inbox-card').filter({ hasText: 'Finished the billing export refactor' });
    await expect(sCard).toBeVisible();
    await expect(sCard.getByTestId('quick-reply')).toHaveText(['continue', 'run the tests', 'commit and push', 'stop here']);
    await shot(page, 'inbox-stop-wait');
    await noHorizontalScroll(page);
    await sCard.getByTestId('quick-reply').filter({ hasText: 'run the tests' }).click();
    const reply = await stop;
    expect(reply).toContain('"decision":"block"');
    expect(reply).toContain('run the tests');
    await expect(page.getByTestId('inbox-card')).toHaveCount(0);
  });

  test('"Let it go idle" releases a finished turn', async ({ loggedIn: page }) => {
    await setWalk(page, true);
    await page.goto('/inbox');
    const stop = hook('Stop', { last_assistant_message: 'All done here, e2e idle check.' });
    const card = page.getByTestId('inbox-card').filter({ hasText: 'e2e idle check' });
    await card.getByTestId('answer-release').click();
    expect(await stop).not.toContain('"decision":"block"');
    await expect(card).toHaveCount(0);
  });
});

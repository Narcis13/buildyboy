import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page } from '@playwright/test';
import { test, expect, login, trackConsoleErrors } from './fixtures.ts';
import { S1, S2, S3 } from '../fixtures/scenario.ts';

const TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Agent', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'mcp__github__get_issue'];

const statePath = (project: string) => join(tmpdir(), `bb-e2e-${project}-session.json`);
test.beforeAll(async ({ browser }, info) => {
  const page = await browser.newPage({ baseURL: process.env.BB_E2E_URL, storageState: { cookies: [], origins: [] } });
  await login(page);
  await page.context().storageState({ path: statePath(info.project.name) });
  await page.close();
});
test.use({ storageState: async ({}, use, info) => use(statePath(info.project.name)) });

async function shot(page: Page, name: string) {
  if (process.env.BB_SHOTS) await page.screenshot({ path: join(process.env.BB_SHOTS, `${name}.png`) });
}

/** The timeline is virtualized: scroll it top to bottom and collect every data-testid that rendered. */
async function collectTestIds(page: Page): Promise<Set<string>> {
  const tl = page.getByTestId('timeline');
  await expect(page.getByTestId('timeline-item').first()).toBeVisible();
  await tl.evaluate((el) => (el.scrollTop = 0));
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    await page.waitForTimeout(50);
    for (const id of await tl.evaluate((el) => [...el.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')!))) seen.add(id);
    const moved = await tl.evaluate((el) => {
      const before = el.scrollTop;
      el.scrollTop += el.clientHeight * 0.6;
      return el.scrollTop !== before;
    });
    if (!moved) break;
  }
  return seen;
}

test('session S1 timeline renders every tool type', async ({ page }, info) => {
  const errors = trackConsoleErrors(page);
  await page.goto(`/s/${S1}`);
  await expect(page.getByTestId('session-header')).toContainText('Add rate limiting to login');
  await expect(page.getByTestId('session-status')).toHaveText(/idle/i);
  await expect(page.getByTestId('timeline-item').first()).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, `session-${info.project.name}`);

  const seen = await collectTestIds(page);
  for (const t of TOOLS) expect(seen, `tool-${t} rendered`).toContain(`tool-${t}`);
  for (const id of ['diff', 'exit-code', 'question-card', 'plan', 'todo-list', 'open-lane']) expect(seen, id).toContain(id);

  // a scrolled-up timeline offers a way back to live
  await page.getByTestId('timeline').evaluate((el) => (el.scrollTop = 0));
  await expect(page.getByTestId('jump-live')).toBeVisible();
  await page.getByTestId('jump-live').click();
  await expect(page.getByTestId('jump-live')).toHaveCount(0);
  await shot(page, `session-${info.project.name}-bottom`);

  // the Agent card opens the subagent's lane
  await page.getByTestId('timeline').evaluate((el) => (el.scrollTop = 0));
  await page.getByTestId('lane-agent-fx-review').click();
  await expect(page.getByTestId('tool-Read')).toBeVisible();
  await expect(page.getByTestId('tool-Grep')).toBeVisible();
  await expect(page.getByTestId('tool-Bash')).toHaveCount(0);
  await page.getByRole('button', { name: 'Main', exact: true }).click();

  // progress panel highlights Next and Decisions
  await page.getByRole('tab', { name: 'Progress' }).click();
  await expect(page.getByTestId('progress-next')).toContainText('Open the PR');
  await expect(page.getByTestId('progress-decisions')).toBeVisible();
  await page.getByRole('tab', { name: 'Git' }).click();
  await expect(page.getByTestId('git-panel')).toContainText('Add login rate limiting');
  if (info.project.name === 'phone') {
    await shot(page, 'session-phone-git');
    await page.getByRole('tab', { name: 'Timeline' }).click();
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('compose queues and cancels a message', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.goto(`/s/${S1}`);
  await page.getByLabel('Message to the session').fill('please also update the README');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const queued = page.getByTestId('queued-message').filter({ hasText: 'please also update the README' });
  await expect(queued).toBeVisible();
  await queued.getByRole('button', { name: 'Cancel' }).click();
  await expect(queued).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('session S3 shows the raw line and the StopFailure', async ({ page }, info) => {
  const errors = trackConsoleErrors(page);
  await page.goto(`/s/${S3}`);
  await expect(page.getByTestId('session-status')).toHaveText(/ended/i);
  await expect(page.getByTestId('timeline-raw')).toBeVisible();
  await expect(page.getByTestId('timeline-raw')).toContainText('bb-unknown-future-line');
  await expect(page.getByTestId('event-StopFailure')).toHaveAttribute('data-level', 'error');
  await expect(page.getByTestId('compose')).toContainText('Session ended');
  await expect(page.getByTestId('compose').getByRole('textbox')).toHaveCount(0);
  await shot(page, `session-${info.project.name}-s3`);
  expect(errors).toEqual([]);
});

test('session S2 is waiting and replay scrubs the timeline', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.goto(`/s/${S2}`);
  await expect(page.getByTestId('session-status')).toHaveText(/waiting/i);
  const seen = await collectTestIds(page);
  for (const id of ['event-PreCompact', 'event-PostCompact', 'event-PermissionRequest', 'tool-Bash', 'tool-Read']) expect(seen, id).toContain(id);
  await page.getByTestId('replay-toggle').click();
  await expect(page.getByTestId('replay')).toBeVisible();
  // at the start only the first item is shown
  await expect(page.getByTestId('timeline-item')).toHaveCount(1);
  await expect(page.getByTestId('event-SessionStart')).toBeVisible();
  // scrub to the end: the latest items are back (and the timeline follows them)
  const scrub = page.getByTestId('replay-scrubber');
  await scrub.fill((await scrub.getAttribute('max'))!);
  await expect(page.getByTestId('event-Notification').last()).toBeVisible();
  await expect.poll(() => page.getByTestId('timeline-item').count()).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Exit replay' }).click();
  await expect(page.getByTestId('replay')).toHaveCount(0);
  expect(errors).toEqual([]);
});

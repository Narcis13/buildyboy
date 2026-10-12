import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page } from '@playwright/test';
import { test, expect, login, trackConsoleErrors } from './fixtures.ts';

// Log in once per project; the login endpoint is rate limited.
const statePath = (project: string) => join(tmpdir(), `bb-e2e-${project}-jobs.json`);
test.beforeAll(async ({ browser }, info) => {
  const page = await browser.newPage({ baseURL: process.env.BB_E2E_URL, storageState: { cookies: [], origins: [] } });
  await login(page);
  await page.context().storageState({ path: statePath(info.project.name) });
  await page.close();
});
test.use({ storageState: async ({}, use, info) => use(statePath(info.project.name)) });

async function shot(page: Page, name: string) {
  if (process.env.BB_SHOTS) await page.screenshot({ path: join(process.env.BB_SHOTS, `${name}.png`), fullPage: true });
}

/** No runner is online in e2e, so "missing resource" noise from optional endpoints is not a page error. */
const realErrors = (errors: string[]) => errors.filter((e) => !/status of 404/.test(e));

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

/** Known projects come first in the picker; "Other path…" reveals a free path field. */
async function customDir(page: Page, path: string) {
  await page.getByLabel('Project directory').selectOption('__other__');
  await page.getByLabel('Directory path').fill(path);
}

/** Machine tokens written by scripts/simulate.ts into the e2e data dir. */
function machineA(): { id: string; token: string } {
  return JSON.parse(readFileSync(join(process.env.BB_E2E_DATA!, 'simulate-tokens.json'), 'utf8')).A;
}

test('jobs page renders the list and schedules', async ({ page }, info) => {
  const errors = trackConsoleErrors(page);
  await page.goto('/jobs');
  await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New job' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Schedules' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Active' })).toBeVisible();
  await noHorizontalScroll(page);
  await shot(page, `jobs-list-${info.project.name}`);
  expect(realErrors(errors)).toEqual([]);
});

test('launch form renders, queues a job, and the job page shows runner output', async ({ page, request }, info) => {
  const errors = trackConsoleErrors(page);
  const m = machineA();
  await page.goto('/jobs?new=1');
  await expect(page.getByRole('heading', { name: 'Launch a job' })).toBeVisible();
  for (const label of ['Saved prompt', 'Machine', 'Max budget USD', 'Model', 'Fallback model', 'Effort', 'Permission mode', 'Max turns', 'Extra allowed tools', 'Disallowed tools', 'Limit minutes']) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('switch', { name: 'New git worktree (-w)' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Walk mode' })).toBeVisible();
  await expect(page.getByLabel('Max budget USD')).toHaveValue('5');
  await page.getByLabel('Machine', { exact: true }).selectOption(m.id);
  // the simulated sessions made projects on this machine; they are offered as directories
  await expect(page.getByLabel('Project directory').locator('option')).not.toHaveCount(1);
  await noHorizontalScroll(page);
  // phone-first: every control in the form is a comfortable touch target
  for (const el of await page.getByRole('form', { name: 'Launch form' }).locator('button:visible, select:visible, input:visible, textarea:visible').all()) {
    const box = await el.boundingBox();
    expect(box!.height, await el.evaluate((n) => n.outerHTML.slice(0, 80))).toBeGreaterThanOrEqual(44);
  }
  await shot(page, `jobs-launch-${info.project.name}`);

  // a bad option is caught before it reaches the server
  await page.getByLabel('Model', { exact: true }).fill('sonnet; rm -rf /');
  await expect(page.getByRole('alert')).toContainText('invalid model');
  await expect(page.getByRole('button', { name: 'Launch job' })).toBeDisabled();
  await page.getByLabel('Model', { exact: true }).fill('sonnet');

  await page.getByLabel('Prompt text').fill('Goal: list the files\nDone when: `npm test` passes');
  await customDir(page, `C:\\code\\e2e-${info.project.name}`);
  await page.getByRole('button', { name: 'Launch job' }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').pop()!;
  await expect(page.getByText('queued', { exact: true })).toBeVisible();
  await expect(page.getByText('Waiting for the runner on this machine to come online')).toBeVisible();
  await expect(page.getByLabel('Verify commands')).toHaveValue('npm test');

  // play the runner's part with the machine token: status, fixture stream-json, result
  const lines = readFileSync('fixtures/stream-json/basic.jsonl', 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.replaceAll('{{SESSION_ID}}', '99999999-9999-4999-8999-999999999999').replaceAll('{{CWD}}', 'C:/code/e2e'));
  const post = (events: unknown[]) => request.post(`/api/runner/jobs/${id}/events`, { headers: { authorization: `Bearer ${m.token}` }, data: { events } });
  expect((await post([{ type: 'status', status: 'running', sessionId: '99999999-9999-4999-8999-999999999999' }, { type: 'output', lines }])).ok()).toBe(true);
  await expect(page.getByTestId('job-output')).toContainText('The project has a');
  await expect(page.getByTestId('job-output')).toContainText('Bash');
  await expect(page.getByTestId('job-output').getByText("I'll look at the project first.")).toHaveCount(1); // no duplicate lines across live refetches
  await expect(page.getByRole('form', { name: 'Follow-up message' })).toBeVisible();
  expect((await post([{ type: 'status', status: 'succeeded', exitCode: 0, costUsd: 0.0123, result: { subtype: 'success' } }])).ok()).toBe(true);
  await expect(page.getByText('succeeded', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rerun' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify (runner offline)' })).toBeDisabled();
  await expect(page.getByRole('link', { name: /session page/ })).toHaveAttribute('href', '/s/99999999-9999-4999-8999-999999999999');
  await noHorizontalScroll(page);
  await shot(page, `jobs-detail-${info.project.name}`);

  await page.goto('/jobs');
  await expect(page.getByTestId('job-row').first()).toBeVisible();
  await shot(page, `jobs-list-filled-${info.project.name}`);
  expect(realErrors(errors)).toEqual([]);
});

test('schedule form creates a cron schedule', async ({ page }, info) => {
  const errors = trackConsoleErrors(page);
  await page.goto('/jobs?new=1&schedule=1');
  await expect(page.getByRole('heading', { name: 'New schedule' })).toBeVisible();
  await page.getByLabel('Machine', { exact: true }).selectOption(machineA().id);
  await page.getByLabel('Prompt text').fill(`Goal: nightly deps ${info.project.name}`);
  await customDir(page, 'C:\\code\\deps');
  await page.getByLabel('Cron').fill('0 2 * * *');
  await page.getByRole('button', { name: 'Create schedule' }).click();
  await expect(page).toHaveURL(/\/jobs#schedules$/);
  await expect(page.getByText(`nightly deps ${info.project.name}`)).toBeVisible();
  expect(realErrors(errors)).toEqual([]);
});

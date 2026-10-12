import { readFileSync } from 'node:fs';
import { test, expect, login, trackConsoleErrors } from './fixtures.ts';
import type { Page } from '@playwright/test';

/** On a phone the form and the preview are separate panes; on desktop they sit side by side. */
async function showPane(page: Page, pane: 'Edit' | 'Preview') {
  const tab = page.getByRole('tab', { name: new RegExp(`^${pane}`) });
  if (await tab.isVisible()) await tab.click();
}

async function fillAll(page: Page) {
  await page.getByLabel('Goal', { exact: true }).fill('Add rate limiting to the login endpoint');
  await page.getByLabel('Done when check 1').fill('`npm test` passes');
  await page.getByLabel('Done when check 1').press('Enter');
  await page.getByLabel('Done when check 2').fill('`/health` returns 200');
  await page.getByLabel('Scope', { exact: true }).fill('server/ and tests/');
  await page.getByLabel('Limit', { exact: true }).fill('4 hours');
  await page.getByLabel('Subagents', { exact: true }).fill('3');
  await page.getByRole('radio', { name: 'new' }).click();
  await page.getByLabel('Branch name').fill('feat/rate-limit');
  await page.getByRole('switch', { name: 'PR' }).click();
  await page.getByRole('switch', { name: 'Unattended' }).click();
}

// One login for the whole file (the login endpoint rate-limits), one page shared by the serial tests.
test.describe.configure({ mode: 'serial' });
let page: Page;
test.beforeAll(async ({ browser }, info) => {
  const ctx = await browser.newContext({ ...info.project.use, baseURL: process.env.BB_E2E_URL });
  page = await ctx.newPage();
  await login(page);
});
test.afterAll(async () => {
  await page.context().close();
});
test.beforeEach(async () => {
  await page.goto('/composer');
  await expect(page.getByLabel('Goal', { exact: true })).toBeVisible();
});

test('parses harness-prompt.md into 8 slots with the right controls', async () => {
  const errors = trackConsoleErrors(page);
  const goal = page.getByLabel('Goal', { exact: true });
  await expect(goal).toHaveJSProperty('tagName', 'TEXTAREA');
  await expect(goal).toHaveJSProperty('rows', 5);
  await expect(page.getByRole('group', { name: 'Done when' })).toBeVisible();
  await expect(page.getByLabel('Done when check 1')).toBeVisible();
  for (const name of ['Scope', 'Limit']) await expect(page.getByLabel(name, { exact: true })).toHaveJSProperty('tagName', 'TEXTAREA');
  const subagents = page.getByLabel('Subagents', { exact: true });
  await expect(subagents).toHaveAttribute('type', 'number');
  await expect(subagents).toHaveValue('5');
  const branch = page.getByRole('radiogroup', { name: 'Branch' });
  await expect(branch.getByRole('radio')).toHaveText(['new', 'current']);
  await expect(page.getByLabel('Branch name')).toBeVisible();
  for (const name of ['PR', 'Unattended']) await expect(page.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#tpl-select')).toContainText('harness');
  expect(errors).toEqual([]);
});

test('fill in the slots and see them rendered back', async () => {
  const errors = trackConsoleErrors(page);
  await fillAll(page);
  await showPane(page, 'Preview');
  const preview = page.getByTestId('preview');
  await expect(preview).toContainText('Add rate limiting to the login endpoint');
  await expect(preview).toContainText('4 hours');
  await expect(preview).toContainText('/health');
  await expect(preview).toContainText('feat/rate-limit');
  await expect(preview).toContainText('How to work');
  await expect(page.getByTestId('lint-summary')).toHaveText('');
  await page.getByRole('tab', { name: 'Raw Markdown' }).click();
  const raw = page.getByTestId('raw-preview');
  await expect(raw).toContainText('Goal: Add rate limiting to the login endpoint');
  await expect(raw).toContainText('Branch: new, `feat/rate-limit`');
  await expect(raw).toContainText('Subagents: 3');
  await expect(raw).toContainText('Unattended: yes');
  await expect(raw).toContainText('1. `npm test` passes');
  await expect(raw).not.toContainText('<what you want');
  // spec attachment
  await showPane(page, 'Edit');
  await page.getByLabel('Spec markdown').fill('Spec line A');
  await showPane(page, 'Preview');
  await expect(raw).toContainText('## Spec');
  await expect(raw).toContainText('Spec line A');
  expect(errors).toEqual([]);
});

test('lint warnings: PR yes needs a new branch, unattended needs a limit, empty Done when', async () => {
  await fillAll(page);
  await expect(page.getByTestId('lint-pr-needs-branch')).toHaveCount(0);
  await page.getByRole('radio', { name: 'current' }).click();
  await expect(page.getByTestId('lint-pr-needs-branch')).toContainText('PR: yes needs a new branch');
  await expect(page.getByLabel('Branch name')).toHaveCount(0);
  await page.getByLabel('Limit', { exact: true }).fill('');
  await expect(page.getByTestId('lint-unattended-no-limit')).toBeVisible();
  await page.getByLabel('Done when check 1').fill('');
  await page.getByLabel('Done when check 2').fill('');
  await expect(page.getByTestId('lint-done-empty')).toBeVisible();
  await page.getByLabel('Done when check 1').fill('it feels finished');
  await expect(page.getByTestId('lint-done-no-command')).toBeVisible();
  await showPane(page, 'Preview');
  await expect(page.getByTestId('lint-summary')).toContainText('PR: yes needs a new branch');
  await showPane(page, 'Edit');
  await page.getByRole('radio', { name: 'new' }).click();
  await expect(page.getByTestId('lint-pr-needs-branch')).toHaveCount(0);
});

test('save to the library, reload it, version history with a diff, launch', async ({}, info) => {
  const errors = trackConsoleErrors(page);
  const title = `E2E rate limit ${info.project.name}`;
  await fillAll(page);
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Tags').fill('e2e, backend');
  await page.getByRole('button', { name: 'Save to library' }).click();
  await expect(page.getByRole('status')).toContainText('Saved as version 1');
  await expect(page).toHaveURL(/\/composer\/\d+$/);
  const id = new URL(page.url()).pathname.split('/').pop()!;

  // reload: the saved prompt comes back with its values
  await page.reload();
  await expect(page.getByLabel('Goal', { exact: true })).toHaveValue('Add rate limiting to the login endpoint');
  await expect(page.getByLabel('Done when check 2')).toHaveValue('`/health` returns 200');
  await expect(page.getByLabel('Subagents', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('Branch name')).toHaveValue('feat/rate-limit');
  await expect(page.getByRole('switch', { name: 'PR' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('Title')).toHaveValue(title);
  await expect(page.getByLabel('Tags')).toHaveValue('e2e, backend');

  // a second save makes version 2 and the history shows the diff
  await page.getByLabel('Goal', { exact: true }).fill('Throttle repeated sign-ins');
  await expect(page.getByRole('status')).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByRole('status')).toContainText('Saved as version 2');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const diff = page.getByTestId('version-diff');
  await expect(diff).toContainText('-Goal: Add rate limiting to the login endpoint');
  await expect(diff).toContainText('+Goal: Throttle repeated sign-ins');

  // library: search, tags, stats, duplicate
  await page.getByRole('tab', { name: 'Library' }).click();
  const item = page.getByTestId('library-item').filter({ hasText: title });
  await expect(item).toBeVisible();
  await expect(item.getByTestId('prompt-stats')).toHaveText('No runs yet');
  await page.getByLabel('Search prompts').fill('sign-ins');
  await expect(item).toBeVisible();
  await page.getByLabel('Search prompts').fill('zzz-nothing');
  await expect(page.getByTestId('library-item')).toHaveCount(0);
  await page.getByLabel('Search prompts').fill('');
  await page.getByRole('button', { name: 'backend', exact: true }).click();
  await expect(item).toBeVisible();
  await page.getByRole('button', { name: 'backend', exact: true }).click();
  await item.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page).toHaveURL(new RegExp(`/composer/(?!${id}$)\\d+$`));
  await expect(page.getByLabel('Title')).toHaveValue(`${title} (copy)`);

  // launch goes to the jobs launch form with the prompt id
  await showPane(page, 'Preview');
  await page.getByRole('button', { name: 'Launch as a job' }).click();
  await expect(page).toHaveURL(/\/jobs\?new=1&prompt=\d+$/);
  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

test('outputs: command lines, TASK.md download, uploaded template', async () => {
  await fillAll(page);
  await showPane(page, 'Preview');
  await expect(page.getByTestId('cmd-bash')).toHaveText('claude -p "$(cat TASK.md)" --permission-mode acceptEdits --max-budget-usd 5');
  await expect(page.getByTestId('cmd-powershell')).toHaveText('claude -p (Get-Content -Raw TASK.md) --permission-mode acceptEdits --max-budget-usd 5');
  await page.getByLabel('Permission mode').selectOption('plan');
  await page.getByLabel('Max budget (USD)').fill('12.5');
  await expect(page.getByTestId('cmd-bash')).toHaveText('claude -p "$(cat TASK.md)" --permission-mode plan --max-budget-usd 12.5');
  await page.getByRole('button', { name: 'Copy Bash command' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download TASK.md' }).click()]);
  expect(dl.suggestedFilename()).toBe('TASK.md');
  const text = readFileSync(await dl.path(), 'utf8');
  expect(text).toContain('Goal: Add rate limiting to the login endpoint');
  expect(text).toContain('## Guardrails');

  // paste an extra template: each <placeholder> becomes a field
  await showPane(page, 'Edit');
  await page.getByRole('button', { name: '+ Add template' }).click();
  await page.getByLabel('Template name').fill('e2e bugfix');
  await page.getByLabel(/Template markdown/).fill('Fix <the bug> in <module>.\n');
  await page.getByRole('button', { name: 'Add template', exact: true }).click();
  await expect(page.locator('#tpl-select')).toHaveValue(/\d+/);
  await expect(page.getByLabel('the bug', { exact: true })).toBeVisible();
  await page.getByLabel('the bug', { exact: true }).fill('login crash');
  await page.getByLabel('module', { exact: true }).fill('auth');
  await showPane(page, 'Preview');
  await expect(page.getByTestId('preview')).toContainText('Fix login crash in auth.');
});

test('no horizontal scroll and readable controls', async () => {
  await fillAll(page);
  const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth');
  expect(overflow).toBeLessThanOrEqual(0);
  for (const loc of [page.getByRole('button', { name: 'Save to library' }), page.getByRole('switch', { name: 'PR' }), page.getByRole('radio', { name: 'new' }), page.getByLabel('Subagents', { exact: true })]) {
    const box = (await loc.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByLabel('Goal', { exact: true })).toHaveCSS('font-size', '15px');
  await showPane(page, 'Preview');
  expect(await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth')).toBeLessThanOrEqual(0);
});

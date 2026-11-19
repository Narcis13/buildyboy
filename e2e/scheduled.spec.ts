// Scheduled starts (§11.8) in the web UI: a package's start time, the scheduled launches and the cron catch-up window.
// Both projects run against the same server and data, so every test that writes creates its own uniquely named records.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page } from '@playwright/test';
import { test, expect, login, trackConsoleErrors } from './fixtures.ts';
import { machineTokens } from '../scripts/simulate.ts';

// Log in once per project; the login endpoint is rate limited.
const statePath = (project: string) => join(tmpdir(), `bb-e2e-${project}-scheduled.json`);
test.beforeAll(async ({ browser }, info) => {
  const page = await browser.newPage({ baseURL: process.env.BB_E2E_URL, storageState: { cookies: [], origins: [] } });
  await login(page);
  await page.context().storageState({ path: statePath(info.project.name) });
  await page.close();
});
test.use({ storageState: async ({}, use, info) => use(statePath(info.project.name)) });

async function csrf(page: Page) {
  return (await page.context().cookies()).find((c) => c.name === 'bb_csrf')?.value ?? '';
}

async function noHorizontalScroll(page: Page) {
  const w = (await page.evaluate('({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })')) as { scroll: number; inner: number };
  expect(w.scroll, `page scrolls horizontally (${w.scroll} > ${w.inner})`).toBeLessThanOrEqual(w.inner);
}

/** A value for a datetime-local input, `days` from now in the browser's (= this process's) time zone. */
function localValue(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setSeconds(0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function makeGata(page: Page, id: string, title: string) {
  const res = await page.request.post('/api/tasks', { headers: { 'x-bb-csrf': await csrf(page) }, data: { id, title, status: 'gata' } });
  expect(res.status(), await res.text()).toBe(201);
}

async function getTask(page: Page, id: string) {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()) as { notBefore: number | null; notBeforeText: string | null };
}

test.describe('package start time', () => {
  test('sets, changes and clears the start time', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    const id = `E2E-ST-${info.project.name}`;
    await page.goto('/');
    await makeGata(page, id, `Start time on ${info.project.name}`);
    await page.goto(`/backlog/${id}`);

    const box = page.getByTestId('task-start');
    await expect(box).toContainText('Start time');
    await expect(page.getByTestId('task-start-text')).toContainText('None');
    await expect(page.getByTestId('task-start-clear')).toHaveCount(0);

    // nothing picked: refused before it reaches the server
    await page.getByTestId('task-start-save').click();
    await expect(page.getByTestId('task-start-error')).toContainText('Pick a date and time');

    // set: a day ahead, shown as waiting with the server's text
    const first = localValue(1);
    await page.getByTestId('task-start-input').fill(first);
    await page.getByTestId('task-start-save').click();
    await expect(page.getByTestId('task-start-text')).toContainText('Starts not before');
    await expect(box).toHaveAttribute('data-waiting', 'true');
    const saved = await getTask(page, id);
    expect(saved.notBefore).toBe(new Date(first).getTime());
    await expect(page.getByTestId('task-start-text')).toContainText(saved.notBeforeText!);
    await expect(page.getByTestId('task-start-error')).toHaveCount(0);

    // survives a reload, and the input is prefilled in the browser's time
    await page.reload();
    await expect(page.getByTestId('task-start-text')).toContainText('Starts not before');
    await expect(page.getByTestId('task-start-input')).toHaveValue(first);

    // change
    const second = localValue(2);
    await page.getByTestId('task-start-input').fill(second);
    await page.getByTestId('task-start-save').click();
    await expect.poll(async () => (await getTask(page, id)).notBefore).toBe(new Date(second).getTime());
    await expect(page.getByTestId('task-start-text')).toContainText((await getTask(page, id)).notBeforeText!);

    // a time that has passed is no longer waiting
    await page.getByTestId('task-start-input').fill(localValue(-1));
    await page.getByTestId('task-start-save').click();
    await expect(page.getByTestId('task-start-text')).toContainText('has passed');
    await expect(box).toHaveAttribute('data-waiting', 'false');

    // touch targets
    for (const tid of ['task-start-save', 'task-start-clear', 'task-start-input']) {
      const b = await page.getByTestId(tid).boundingBox();
      expect(b!.height, tid).toBeGreaterThanOrEqual(44);
    }
    await noHorizontalScroll(page);

    // clear
    await page.getByTestId('task-start-clear').click();
    await expect(page.getByTestId('task-start-text')).toContainText('None');
    await expect(page.getByTestId('task-start-input')).toHaveValue('');
    await expect(page.getByTestId('task-start-clear')).toHaveCount(0);
    expect((await getTask(page, id)).notBefore).toBeNull();
    expect(errors).toEqual([]);
  });
});

test.describe('scheduled launches', () => {
  test('lists a scheduled worker and coordinator launch and cancels them', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    const id = `E2E-SL-${info.project.name}`;
    const title = `Scheduled on ${info.project.name}`;
    await page.goto('/');
    await makeGata(page, id, title);
    const headers = { 'x-bb-csrf': await csrf(page) };
    const tok = await page.request.post('/api/agent-tokens', { data: { name: `e2e-scheduled-${info.project.name}` }, headers });
    const { id: tokenId, token } = (await tok.json()) as { id: string; token: string };
    expect((await page.request.put(`/api/agent-tokens/${tokenId}`, { data: { launch: 'all', launchApproval: false }, headers })).ok()).toBe(true);
    const machineId = machineTokens(process.env.BB_E2E_DATA!).A.id;
    const agent = async (tool: string, args: Record<string, unknown>) => {
      const res = await page.request.post(`/api/agent/${tool}`, { data: args, headers: { authorization: `Bearer ${token}` } });
      expect(res.ok(), `${tool}: ${await res.text()}`).toBe(true);
      return ((await res.json()) as { result: Record<string, unknown> }).result;
    };
    const notBefore = new Date(Date.now() + 86_400_000).toISOString();
    const cwd = `C:\\code\\e2e-sched-${info.project.name}`;
    const worker = await agent('tasks_launch', { taskId: id, machineId, cwd, launcher: 'claude', notBefore });
    expect(worker.status).toBe('scheduled');
    const coordTitle = `E2E coordinator ${info.project.name}`;
    const coord = await agent('coordinator_launch', { machineId, cwd, launcher: 'claude', title: coordTitle, notBefore });
    expect(coord.status).toBe('scheduled');

    // the package carries the start time the launch set
    await page.goto(`/backlog/${id}`);
    await expect(page.getByTestId('task-start-text')).toContainText('Starts not before');

    await page.goto('/jobs#schedules');
    await expect(page.getByRole('heading', { name: 'Scheduled launches' })).toBeVisible();
    const row = page.getByTestId('scheduled-launch').filter({ hasText: title });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-status', 'pending');
    await expect(row.getByTestId('scheduled-status')).toHaveText('pending');
    await expect(row).toContainText(`worker for ${id}`);
    await expect(row.getByTestId('scheduled-not-before')).toContainText((await getTask(page, id)).notBeforeText!);
    await expect(row).toContainText('until');
    await expect(row).toContainText('claude');
    await expect(row.getByTestId('scheduled-waits')).toBeVisible();
    await expect(row.getByTestId('scheduled-task')).toHaveAttribute('href', `/backlog/${id}`);
    const crow = page.getByTestId('scheduled-launch').filter({ hasText: coordTitle });
    await expect(crow).toHaveAttribute('data-kind', 'coordinator');
    await expect(crow).toContainText('coordinator');
    await expect(page.getByTestId('scheduled-empty')).toHaveCount(0);
    expect((await row.getByTestId('scheduled-cancel').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await noHorizontalScroll(page);

    // two taps cancel it; the coordinator one stays pending
    await row.getByTestId('scheduled-cancel').click();
    await expect(row.getByTestId('scheduled-cancel')).toHaveText('Tap again to cancel');
    await expect(row).toHaveAttribute('data-status', 'pending');
    await row.getByTestId('scheduled-cancel').click();
    await expect(row).toHaveAttribute('data-status', 'cancelled');
    await expect(row.getByTestId('scheduled-cancel')).toHaveCount(0);
    await expect(crow).toHaveAttribute('data-status', 'pending');
    // it stays cancelled after a reload
    await page.reload();
    await expect(row).toHaveAttribute('data-status', 'cancelled');

    // clean up the other one
    await crow.getByTestId('scheduled-cancel').click();
    await crow.getByTestId('scheduled-cancel').click();
    await expect(crow).toHaveAttribute('data-status', 'cancelled');
    expect(errors).toEqual([]);
  });

  const view = (over: Record<string, unknown>) => ({
    id: 'mock-1', kind: 'worker', status: 'pending', taskId: 'P9', project: null, title: 'P9: Mocked package', machineId: 'm1', machineName: 'workstation', cwd: 'C:\\code\\x', launcher: 'hc',
    notBefore: Date.now() + 3_600_000, notBeforeText: '2026-11-20 03:30 UTC+02:00', expiresAt: Date.now() + 7_200_000, waits: null, jobId: null, staleStart: false, decisionId: null, actor: 'agent', createdAt: Date.now(), closedAt: null, ...over,
  });

  test('shows the empty state', async ({ page }) => {
    await page.route('**/api/scheduled-launches', (r) => r.fulfill({ json: [] }));
    await page.goto('/jobs#schedules');
    await expect(page.getByTestId('scheduled-empty')).toContainText('tasks_launch');
    await expect(page.getByTestId('scheduled-empty')).toContainText('notBefore');
  });

  test('a missed launch stands out and a started one links to its job', async ({ page }) => {
    await page.route('**/api/scheduled-launches', (r) =>
      r.fulfill({
        json: [
          view({ id: 'mock-missed', status: 'missed', title: 'P8: Missed one', taskId: 'P8', waits: 'runner offline', closedAt: Date.now() }),
          view({ id: 'mock-started', status: 'started', title: 'Coordinator run', kind: 'coordinator', taskId: null, jobId: '12345678-aaaa-4bbb-8ccc-1234567890ab', closedAt: Date.now() }),
        ],
      }),
    );
    await page.goto('/jobs#schedules');
    const missed = page.getByTestId('scheduled-launch').filter({ hasText: 'Missed one' });
    await expect(missed).toHaveAttribute('data-status', 'missed');
    await expect(missed).toContainText('did not start before it expired');
    await expect(missed).toContainText('runner offline');
    await expect(missed.getByTestId('scheduled-cancel')).toHaveCount(0);
    // the alert colour: the badge uses the error colour, not the muted one
    const [badge, errorColor] = await Promise.all([
      missed.getByTestId('scheduled-status').locator('span').evaluate((n) => getComputedStyle(n).color),
      page.evaluate(() => {
        const p = document.createElement('i');
        p.style.color = 'var(--bb-error)';
        document.body.append(p);
        const c = getComputedStyle(p).color;
        p.remove();
        return c;
      }),
    ]);
    expect(badge).toBe(errorColor);
    const started = page.getByTestId('scheduled-launch').filter({ hasText: 'Coordinator run' });
    await expect(started.getByTestId('scheduled-status')).toHaveText('started');
    await expect(started.getByTestId('scheduled-job')).toHaveAttribute('href', '/jobs/12345678-aaaa-4bbb-8ccc-1234567890ab');
    await expect(started.getByTestId('scheduled-task')).toHaveCount(0);
    await noHorizontalScroll(page);
  });
});

test.describe('cron catch-up', () => {
  test('the schedule form sends a catch-up window and the list shows it', async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    const machineId = machineTokens(process.env.BB_E2E_DATA!).A.id;
    const create = async (title: string, catchUp: string | null) => {
      await page.goto('/jobs?new=1&schedule=1');
      await expect(page.getByLabel('Catch-up minutes')).toHaveValue('120');
      await page.getByLabel('Machine', { exact: true }).selectOption(machineId);
      await page.getByLabel('Prompt text').fill(`Goal: ${title}`);
      await page.getByLabel('Project directory').selectOption('__other__');
      await page.getByLabel('Directory path').fill('C:\\code\\catchup');
      if (catchUp != null) await page.getByLabel('Catch-up minutes').fill(catchUp);
      await page.getByRole('button', { name: 'Create schedule' }).click();
      await expect(page).toHaveURL(/\/jobs#schedules$/);
    };
    const a = `catch-up default ${info.project.name}`;
    const b = `catch-up off ${info.project.name}`;
    await create(a, null);
    await create(b, '0');
    const rowOf = (t: string) => page.getByRole('listitem').filter({ hasText: t }).filter({ has: page.getByTestId('schedule-catch-up') });
    await expect(rowOf(a).getByTestId('schedule-catch-up')).toHaveText('catch-up 2 h');
    await expect(rowOf(b).getByTestId('schedule-catch-up')).toHaveText('no catch-up');
    await noHorizontalScroll(page);
    expect(errors.filter((e) => !/status of 404/.test(e))).toEqual([]);
  });
});

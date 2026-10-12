import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page } from '@playwright/test';
import { test, expect, login, trackConsoleErrors } from './fixtures.ts';
import { MACHINES, S1, S2, S3 } from '../fixtures/scenario.ts';

const statePath = (project: string) => join(tmpdir(), `bb-e2e-${project}-floor.json`);
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

async function openFloor(page: Page) {
  await page.goto('/');
  // "All" so the test doesn't depend on the fixtures landing on today's date
  await page.getByRole('button', { name: 'All', exact: true }).click();
}

test('floor shows the simulated sessions grouped by machine', async ({ page }, info) => {
  const errors = trackConsoleErrors(page);
  await openFloor(page);
  const phone = info.project.name === 'phone';

  await expect(page.getByTestId(phone ? 'floor-list' : 'floor-canvas')).toBeVisible();
  await expect(page.getByTestId(phone ? 'floor-canvas' : 'floor-list')).toHaveCount(0);
  for (const id of [S1, S2, S3]) await expect(page.getByTestId(`station-${id}`)).toBeVisible();

  const waiting = page.getByTestId(`station-${S2}`);
  await expect(waiting).toHaveAttribute('data-status', 'waiting');
  await expect(waiting).toContainText('Waiting on you');
  await expect(page.getByTestId(`station-${S3}`)).toHaveAttribute('data-status', 'ended');
  await expect(page.getByTestId(`station-${S1}`).getByTestId('belt').locator('[data-tool]')).toHaveCount(18);
  await expect(page.getByTestId(`station-${S1}`).locator('[data-tool="Bash"][data-status="error"]')).toHaveCount(1);

  const bays = page.locator('[data-testid^="bay-"]');
  await expect(bays).toHaveCount(2);
  const win = bays.filter({ hasText: MACHINES.A.name });
  const wsl = bays.filter({ hasText: MACHINES.B.name });
  await expect(win).toHaveCount(1);
  await expect(wsl).toHaveCount(1);

  if (phone) {
    // cards live inside their machine's group, waiting first
    // other specs may add sessions to the shared server; the fixture ones must be in the right bay
    await expect(win.getByTestId(`station-${S1}`)).toBeVisible();
    await expect(win.getByTestId(`station-${S2}`)).toBeVisible();
    await expect(win.locator('[data-testid^="station-"]').first()).toHaveAttribute('data-testid', `station-${S2}`);
    await expect(wsl.getByTestId(`station-${S3}`)).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  } else {
    // on the canvas stations sit inside their bay's box
    const inside = async (station: string, bay: typeof win) => {
      const s = (await page.getByTestId(station).boundingBox())!;
      const b = (await bay.boundingBox())!;
      return s.x >= b.x && s.y >= b.y && s.x + s.width <= b.x + b.width + 1 && s.y + s.height <= b.y + b.height + 1;
    };
    expect(await inside(`station-${S1}`, win)).toBe(true);
    expect(await inside(`station-${S2}`, win)).toBe(true);
    expect(await inside(`station-${S3}`, wsl)).toBe(true);
  }
  await shot(page, `floor-${info.project.name}`);

  if (phone) {
    await page.getByRole('button', { name: 'Canvas' }).click();
    await expect(page.getByTestId('floor-canvas')).toBeVisible();
    await expect(page.getByTestId(`station-${S2}`)).toBeVisible();
    await shot(page, `floor-${info.project.name}-canvas`);
    await page.getByRole('button', { name: 'List' }).click();
  }

  await page.getByTestId(`station-${S1}`).click();
  await expect(page).toHaveURL(new RegExp(`/s/${S1}$`));
  await expect(page.getByTestId('session-header')).toBeVisible();
  expect(errors).toEqual([]);
});

test('floor filters by machine and live', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await openFloor(page);
  await page.getByLabel('Machine', { exact: true }).selectOption({ label: MACHINES.B.name });
  await expect(page.getByTestId(`station-${S3}`)).toBeVisible();
  await expect(page.getByTestId(`station-${S1}`)).toHaveCount(0);
  await page.getByLabel('Machine', { exact: true }).selectOption({ label: 'All machines' });
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.getByTestId(`station-${S2}`)).toBeVisible();
  await expect(page.getByTestId(`station-${S3}`)).toHaveCount(0);
  // leave the stored filter on a neutral setting for the next test
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByTestId(`station-${S3}`)).toBeVisible();
  expect(errors).toEqual([]);
});

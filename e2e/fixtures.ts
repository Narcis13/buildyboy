import { test as base, expect, type Page } from '@playwright/test';

/** baseURL comes from global-setup; `loggedIn` gives a page with a session cookie. */
export const test = base.extend<{ loggedIn: Page }>({
  baseURL: async ({}, use) => use(process.env.BB_E2E_URL),
  loggedIn: async ({ page }, use) => {
    await login(page);
    await use(page);
  },
});

export async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Password').fill(process.env.BB_E2E_PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('button', { name: 'Log in' })).toHaveCount(0);
}

/** Collects console errors so each test can assert there were none. */
export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

export { expect };

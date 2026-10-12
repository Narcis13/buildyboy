import { test, expect, login, trackConsoleErrors } from './fixtures.ts';

test('logging in', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText('wrong password');
  await login(page);
  // the app shell (desktop header or phone tab bar) is visible once logged in
  await expect(page.getByRole('link', { name: /Inbox/ }).first()).toBeVisible();
  expect(errors.filter((e) => !e.includes('401'))).toEqual([]);
});

// End-to-end control flows with the real plugin hook script: the browser answers, the waiting bb-hook.mjs prints the JSON.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, trackConsoleErrors } from './fixtures.ts';
import { machineTokens } from '../scripts/simulate.ts';

const HOOK = join(import.meta.dirname, '..', 'plugin', 'hooks', 'bb-hook.mjs');

/** Runs bb-hook.mjs as Claude Code would: hook JSON on stdin, decision JSON on stdout. */
function runHook(args: string[], input: Record<string, unknown>): Promise<{ stdout: string; code: number | null }> {
  const a = machineTokens(process.env.BB_E2E_DATA!).A;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK, ...args], {
      env: { ...process.env, BUILDYBOY_URL: process.env.BB_E2E_URL, BUILDYBOY_TOKEN: a.token, BUILDYBOY_HOME: mkdtempSync(join(tmpdir(), 'bb-e2e-home-')) },
    });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.on('close', (code) => resolve({ stdout, code }));
    p.stdin.end(JSON.stringify(input));
  });
}

async function csrf(page: Page) {
  return (await page.context().cookies()).find((c) => c.name === 'bb_csrf')?.value ?? '';
}

test.describe.configure({ mode: 'serial' });

test('answering a pending permission in the Inbox releases the waiting bb-hook.mjs', async ({ loggedIn: page }, info) => {
  const errors = trackConsoleErrors(page);
  const sid = `e2e-perm-${info.project.name}-${Date.now()}`;
  const base = { session_id: sid, cwd: 'C:\\work\\shop-api', transcript_path: 'C:\\nowhere.jsonl', permission_mode: 'default' };
  await runHook([], { ...base, hook_event_name: 'SessionStart', source: 'startup' });
  await page.request.post('/api/global/walk', { data: { on: true }, headers: { 'x-bb-csrf': await csrf(page) } });
  try {
    const hook = runHook(['--control'], { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm run e2e-release' } });
    await page.goto('/inbox');
    const card = page.getByTestId('inbox-card').filter({ hasText: 'npm run e2e-release' });
    await expect(card).toBeVisible();
    await card.getByTestId('answer-allow').click();
    const r = await hook;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    await expect(card).toHaveCount(0);
  } finally {
    await page.request.post('/api/global/walk', { data: { on: false }, headers: { 'x-bb-csrf': await csrf(page) } });
  }
  expect(errors.filter((e) => !e.includes('401'))).toEqual([]);
});

test('a message queued in the session page is delivered through the Stop hook', async ({ loggedIn: page }, info) => {
  const errors = trackConsoleErrors(page);
  const sid = `e2e-queue-${info.project.name}-${Date.now()}`;
  const base = { session_id: sid, cwd: 'C:\\work\\shop-api', transcript_path: 'C:\\nowhere.jsonl', permission_mode: 'default' };
  await runHook([], { ...base, hook_event_name: 'SessionStart', source: 'startup' });
  await runHook(['--control'], { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'refactor the limiter' });
  await page.goto(`/s/${sid}`);
  const compose = page.getByTestId('compose');
  await compose.getByRole('textbox').fill('now run the tests and commit');
  await compose.getByRole('button', { name: /queue|send/i }).first().click();
  await expect(page.getByTestId('queued-message')).toContainText('now run the tests and commit');
  const r = await runHook(['--control'], { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Refactored.' });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ decision: 'block', reason: 'now run the tests and commit' });
  await expect(page.getByTestId('queued-message')).toHaveCount(0);
  expect(errors.filter((e) => !e.includes('401'))).toEqual([]);
});

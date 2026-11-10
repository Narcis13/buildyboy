// The factory pages (backlog, package, decisions, settings) on the seeded fixtures (fixtures/factory.ts), at both viewports.
// Both projects run against the same server and data, so every test that writes creates its own uniquely named records.
import type { Page } from '@playwright/test';
import { test, expect, trackConsoleErrors } from './fixtures.ts';

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

async function csrf(page: Page) {
  return (await page.context().cookies()).find((c) => c.name === 'bb_csrf')?.value ?? '';
}

async function noHorizontalScroll(page: Page) {
  const w = (await page.evaluate('({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })')) as { scroll: number; inner: number };
  expect(w.scroll, `page scrolls horizontally (${w.scroll} > ${w.inner})`).toBeLessThanOrEqual(w.inner);
}

/** Asks a decision the way the coordinator does: with an agent token, through POST /api/agent/decision_ask. */
async function askDecision(page: Page, name: string, args: Record<string, unknown>): Promise<string> {
  const headers = { 'x-bb-csrf': await csrf(page) };
  const tok = await page.request.post('/api/agent-tokens', { data: { name }, headers });
  expect(tok.status()).toBe(201);
  const { token } = (await tok.json()) as { token: string };
  const res = await page.request.post('/api/agent/decision_ask', { data: args, headers: { authorization: `Bearer ${token}` } });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { result: { id: string } }).result.id;
}

test.describe('backlog', () => {
  test('renders the seeded tasks, the governor and the gate chips', async ({ loggedIn: page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/backlog');
    await expect(page.getByRole('heading', { name: 'Backlog', level: 1 })).toBeVisible();
    await expect(page.getByTestId('governor-banner')).toBeVisible();
    await expect(page.getByTestId('governor-banner').getByRole('progressbar')).toHaveCount(2);

    if (isPhone(page)) {
      // one list under a status filter with counts
      await expect(page.getByTestId('board')).toHaveCount(0);
      await expect(page.getByTestId('filter-all')).toContainText(/All \d+/);
      await page.getByTestId('filter-gata').click();
      await expect(page.getByTestId('task-card').filter({ hasText: 'Reporting dashboard' })).toBeVisible();
      await expect(page.getByTestId('task-card').filter({ hasText: 'Stock movements' })).toHaveCount(0);
      await page.getByTestId('filter-all').click();
    } else {
      // six columns in status order
      await expect(page.getByTestId('board').locator('> section')).toHaveCount(6);
      await expect(page.getByTestId('column-in_lucru').getByTestId('task-card').filter({ hasText: 'Stock movements' })).toBeVisible();
      await expect(page.getByTestId('column-integrata').getByTestId('task-card').filter({ hasText: 'Customer accounts' })).toBeVisible();
      await expect(page.getByTestId('column-blocata').getByTestId('task-card').filter({ hasText: 'Payment gateway sandbox' })).toBeVisible();
    }

    const p3 = page.getByTestId('task-card').filter({ hasText: 'Stock movements' });
    await expect(p3).toContainText('sensitive');
    await expect(p3).toContainText('open request');
    const p5 = page.getByTestId('task-card').filter({ hasText: 'Reporting dashboard' });
    await expect(p5).toContainText('ready');
    await expect(page.getByTestId('task-card').filter({ hasText: 'Mobile layout polish' })).toContainText('waits on P3');
    const p4 = page.getByTestId('task-card').filter({ hasText: 'Invoice export' });
    await expect(p4.locator('[data-gate="G1"]')).toHaveAttribute('data-verdict', 'pass');
    await expect(p4.locator('[data-gate="G5"]')).toHaveAttribute('data-verdict', 'none');

    // search narrows the list
    await page.getByTestId('backlog-search').fill('Invoice');
    await expect(page.getByTestId('task-card')).toHaveCount(1);
    await page.getByTestId('backlog-search').fill('');
    await expect(page.getByTestId('task-card').filter({ hasText: 'Stock movements' })).toBeVisible();

    await noHorizontalScroll(page);
    expect(errors).toEqual([]);
  });

  test('creates a task from the form', async ({ loggedIn: page }, info) => {
    const errors = trackConsoleErrors(page);
    const id = `E2E-${info.project.name}`;
    await page.goto('/backlog');
    await page.getByTestId('new-task-open').click();
    await page.getByTestId('nt-title').fill(`E2E task on ${info.project.name}`);
    await page.getByTestId('nt-id').fill(id);
    await page.getByTestId('nt-body').fill('Written by the e2e suite.');
    await page.getByTestId('nt-acceptance').fill('First criterion\nSecond criterion\n');
    await page.getByTestId('nt-deps').getByText('Project scaffold and CI').click();
    await page.getByTestId('nt-status').selectOption('gata');
    await noHorizontalScroll(page);
    await page.getByTestId('nt-submit').click();

    await expect(page).toHaveURL(new RegExp(`/backlog/${id}$`));
    await expect(page.getByTestId('task-title')).toHaveText(`E2E task on ${info.project.name}`);
    await expect(page.getByTestId('task-acceptance').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('dep-link')).toHaveAttribute('data-task', 'P1');
    await expect(page.getByTestId('task-header')).toContainText('ready'); // gata, and P1 is integrated

    // changing the status from the package page
    await page.getByTestId('task-status').selectOption('blocata');
    await expect(page.getByTestId('history-item').first()).toContainText('Gata → Blocată');

    await page.goto('/backlog');
    await expect(page.getByTestId('task-card').filter({ hasText: id })).toBeVisible();

    // a taken id is refused
    await page.getByTestId('new-task-open').click();
    await page.getByTestId('nt-title').fill('Same id again');
    await page.getByTestId('nt-id').fill(id);
    await page.getByTestId('nt-submit').click();
    await expect(page.getByTestId('nt-error')).toContainText('already exists');
    expect(errors.filter((e) => !/409/.test(e))).toEqual([]);
  });

  test('imports Markdown', async ({ loggedIn: page }, info) => {
    const id = `MD-${info.project.name}`;
    await page.goto('/backlog');
    await page.getByTestId('import-open').click();
    await page.getByTestId('imp-files').setInputFiles({
      name: 'one.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(`---\nid: ${id}\ntitle: Imported from a file on ${info.project.name}\ndepends_on: [P1]\nacceptance:\n  - It was imported\n---\nBody text.\n`),
    });
    await page.getByTestId('imp-md-submit').click();
    await expect(page.getByTestId('import-done')).toContainText(id);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('task-card').filter({ hasText: `Imported from a file on ${info.project.name}` })).toBeVisible();
  });
});

test.describe('package page', () => {
  test('shows gates with a screenshot and records a stop request', async ({ loggedIn: page }, info) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/backlog/P4');
    await expect(page.getByTestId('task-title')).toHaveText('Invoice export');
    await expect(page.getByTestId('task-header')).toContainText('La porți');
    await expect(page.getByTestId('task-cost')).toHaveText('$6.10');

    // five gate rows, the latest verdict of each
    await expect(page.getByTestId('gate-row')).toHaveCount(5);
    await expect(page.locator('[data-testid=gate-row][data-gate=G1]')).toContainText('pass');
    await expect(page.locator('[data-testid=gate-row][data-gate=G3]')).toContainText('Tenant scoping fixed');
    await expect(page.locator('[data-testid=gate-row][data-gate=G3]').getByTestId('gate-earlier')).toContainText('1 earlier attempt');
    await expect(page.locator('[data-testid=gate-row][data-gate=G5]')).toContainText('No result yet');

    // screenshots load, and open full size
    const g4 = page.locator('[data-testid=gate-row][data-gate=G4]');
    await expect(g4.getByTestId('gate-shot')).toHaveCount(2);
    const img = g4.getByTestId('gate-shot').first().locator('img');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await g4.getByTestId('gate-shot').first().click();
    await expect(page.getByTestId('lightbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('lightbox')).toHaveCount(0);

    // the two control buttons, exactly worded
    await expect(page.getByRole('button', { name: 'Cere revenirea integrării' })).toBeVisible();
    const note = `stop from the e2e suite on ${info.project.name}`;
    await page.getByRole('button', { name: 'Oprește pachetul' }).click();
    await page.getByTestId('control-note').fill(note);
    await page.getByTestId('control-confirm').click();
    const item = page.getByTestId('control-item').filter({ hasText: note });
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('data-kind', 'stop');
    await expect(item).toHaveAttribute('data-status', 'open');
    await expect(page.getByTestId('control-list')).toContainText('Stop');
    await expect(page.getByTestId('history-item').first()).toContainText('stop requested');

    await noHorizontalScroll(page);
    expect(errors).toEqual([]);
  });

  test('links the seeded session, decisions and dependencies', async ({ loggedIn: page }) => {
    await page.goto('/backlog/P3');
    await expect(page.getByTestId('task-session')).toHaveAttribute('href', /^\/s\/1{8}-/);
    await expect(page.getByTestId('deps').getByTestId('dep-link')).toHaveCount(2);
    await expect(page.getByTestId('task-pending-decisions')).toContainText('Which rounding rule');
    await expect(page.getByTestId('control-item').first()).toContainText('Hold until the ledger design is confirmed');
    await page.goto('/backlog/NOPE');
    await expect(page.getByRole('alert')).toContainText('There is no task NOPE');
  });
});

test.describe('gate rounds, resources and findings', () => {
  test('shows round, resources and findings, and turns open minors into a package', async ({ loggedIn: page }, info) => {
    const errors = trackConsoleErrors(page);
    const headers = { 'x-bb-csrf': await csrf(page) };
    const repo = `e2e-repo-${info.project.name}`;
    const id = `FX-${info.project.name}`;
    const minor1 = `Rename the helper (${info.project.name})`;
    const minor2 = `Trim the log line (${info.project.name})`;
    const major = `Escape the filter input (${info.project.name})`;

    // a repo config, merged into whatever is there and put back at the end
    const before = (await (await page.request.get('/api/factory/config')).json()) as { maxRounds: number; repos: Record<string, unknown>[] };
    const put = await page.request.put('/api/factory/config', {
      headers,
      data: {
        maxRounds: 3,
        repos: [...before.repos, { repo, machineId: null, checkout: '', recipe: '', worktree: '', portFrom: 4300, portTo: 4399, dbPrefix: 'e2e_', migrationFrom: 500, migrationBlock: 10, cleanup: [] }],
      },
    });
    expect(put.ok(), await put.text()).toBe(true);
    try {
      const mk = await page.request.post('/api/tasks', { headers, data: { id, title: `Findings on ${info.project.name}`, repo, status: 'gata' } });
      expect(mk.status(), await mk.text()).toBe(201);

      const tok = await page.request.post('/api/agent-tokens', { data: { name: `e2e-findings-${info.project.name}` }, headers });
      const { token } = (await tok.json()) as { token: string };
      const agent = async (tool: string, args: Record<string, unknown>) => {
        const res = await page.request.post(`/api/agent/${tool}`, { data: args, headers: { authorization: `Bearer ${token}` } });
        expect(res.ok(), `${tool}: ${await res.text()}`).toBe(true);
        return res.json();
      };
      await agent('tasks_claim', { id, force: true });
      await agent('gates_record', {
        taskId: id,
        gate: 'G3',
        verdict: 'fail',
        summary: 'Review found three things',
        findings: [
          { severity: 'minor', title: minor1, file: 'src/helpers/names.ts', line: 12, detail: 'The name hides what it does.', fix: 'Call it parseName.' },
          { severity: 'minor', title: minor2, file: 'src/log.ts', line: 4 },
          { severity: 'major', title: major, file: 'web/src/Filter.tsx', line: 30 },
        ],
      });

      await page.goto(`/backlog/${id}`);
      await expect(page.getByTestId('task-round')).toHaveText('Round 1 of 3');
      const res = page.getByTestId('task-resources');
      await expect(res).toContainText('4300');
      await expect(res).toContainText(`e2e_${id.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`);
      await expect(res).toContainText('500–509');
      const rows = page.getByTestId('task-findings').getByTestId('finding-row');
      await expect(rows).toHaveCount(3);
      const majorRow = rows.filter({ hasText: major });
      await expect(majorRow).toContainText('major');
      await expect(majorRow).toContainText('web/src/Filter.tsx:30');
      await expect(majorRow).toContainText('G3');
      await expect(majorRow.getByTestId('finding-status')).toHaveValue('open');
      await expect(rows.filter({ hasText: minor1 }).getByTestId('finding-more')).toContainText('Call it parseName.');

      // changing a status goes to the server
      await majorRow.getByTestId('finding-status').selectOption('fixed');
      await expect(majorRow).toHaveAttribute('data-status', 'fixed');
      await noHorizontalScroll(page);

      // the backlog lists the open minors, grouped by package
      await page.goto('/backlog');
      await page.getByTestId('backlog-open-minors').click();
      const group = page.getByTestId('minors-group').filter({ hasText: id });
      await expect(group.getByTestId('minor-check')).toHaveCount(2);
      await expect(group).toContainText(minor1);
      await expect(group).not.toContainText(major);
      await noHorizontalScroll(page);

      // one package from one of them
      await group.locator('label', { hasText: minor1 }).getByTestId('minor-check').check();
      const title = `Cleanups from ${id}`;
      await page.getByTestId('minors-title').fill(title);
      await page.getByTestId('minors-create').click();
      await expect(page.getByTestId('task-title')).toHaveText(title);
      await expect(page.getByTestId('task-body')).toContainText(minor1);

      // the finding it came from is deferred to the new package
      await page.goto(`/backlog/${id}`);
      const done = page.getByTestId('finding-row').filter({ hasText: minor1 });
      await expect(done).toHaveAttribute('data-status', 'deferred');
      await expect(done.getByTestId('finding-deferred-to')).toBeVisible();
      await expect(page.getByTestId('finding-row').filter({ hasText: minor2 })).toHaveAttribute('data-status', 'open');
      expect(errors).toEqual([]);
    } finally {
      await page.request.put('/api/factory/config', { headers, data: before });
    }
  });

  test('saves the factory config from Settings', async ({ loggedIn: page }, info) => {
    const errors = trackConsoleErrors(page);
    const repo = `e2e-cfg-${info.project.name}`;
    const headers = { 'x-bb-csrf': await csrf(page) };
    const before = (await (await page.request.get('/api/factory/config')).json()) as { maxRounds: number; repos: unknown[] };
    try {
      await page.goto('/settings');
      const card = page.getByTestId('settings-factory-config');
      await expect(card).toBeVisible();
      await card.getByTestId('fc-add').click();
      const r = card.getByTestId('fc-repo-block').last();
      await r.getByTestId('fc-repo').fill(repo);
      await r.getByTestId('fc-dbPrefix').fill('bad prefix!');
      await r.getByTestId('fc-cleanup').fill('drop db {db}\n\nrm -rf {worktree}');
      await r.locator('input[id$="-portFrom"]').fill('4400');
      await r.locator('input[id$="-portTo"]').fill('4410');
      await noHorizontalScroll(page);
      await card.getByTestId('fc-save').click();
      await expect(card.getByRole('alert')).toContainText('dbPrefix');
      await r.getByTestId('fc-dbPrefix').fill('e2e_');
      await card.getByTestId('fc-save').click();
      await expect(card.getByRole('status')).toHaveText('Saved');
      const saved = (await (await page.request.get('/api/factory/config')).json()) as { repos: { repo: string; portFrom: number; cleanup: string[] }[] };
      expect(saved.repos.find((x) => x.repo === repo)).toMatchObject({ portFrom: 4400, cleanup: ['drop db {db}', 'rm -rf {worktree}'] });
      await page.reload();
      await expect(page.getByTestId('settings-factory-config').locator(`input[value="${repo}"]`)).toHaveCount(1);
      expect(errors.filter((e) => !/400/.test(e))).toEqual([]);
    } finally {
      await page.request.put('/api/factory/config', { headers, data: before });
    }
  });
});

test.describe('decisions', () => {
  test('lists the seeded questions', async ({ loggedIn: page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/decisions');
    await expect(page.getByRole('heading', { name: 'Decisions', level: 1 })).toBeVisible();
    const seeded = page.getByTestId('decision-card').filter({ hasText: 'Which rounding rule' });
    await expect(seeded).toHaveAttribute('data-status', 'pending');
    await expect(seeded.getByTestId('decision-option')).toHaveCount(2);
    await expect(seeded.getByTestId('decision-context')).toContainText('Banker');
    await expect(page.getByTestId('decisions-history').getByTestId('decision-card').filter({ hasText: 'legacy customer export' })).toContainText('Keep it for one more release');
    // the Inbox points here
    await page.goto('/inbox');
    await expect(page.getByTestId('inbox-decisions-banner')).toBeVisible();
    await expect(page.getByTestId('attention-bar')).toContainText('to answer');
    expect(errors).toEqual([]);
  });

  test('answers with one tap and with free text', async ({ loggedIn: page }, info) => {
    const errors = trackConsoleErrors(page);
    const q1 = `Pick a colour (${info.project.name} ${Date.now()})`;
    const q2 = `Free text question (${info.project.name} ${Date.now()})`;
    const id1 = await askDecision(page, `e2e-${info.project.name}`, { question: q1, options: ['Red', 'Blue'], taskId: 'P5', context: 'Line one\nLine two' });
    const id2 = await askDecision(page, `e2e-${info.project.name}-2`, { question: q2 });
    await page.goto('/decisions');
    const c1 = page.getByTestId('decision-card').filter({ hasText: q1 });
    await expect(c1).toBeVisible();
    await expect(c1.getByTestId('decision-task')).toHaveText('P5');
    await c1.getByTestId('decision-option').filter({ hasText: 'Blue' }).click();
    await expect(page.getByTestId('decisions-pending').getByText(q1)).toHaveCount(0);
    await expect(page.getByTestId('decisions-history').getByTestId('decision-card').filter({ hasText: q1 })).toContainText('Blue');

    const c2 = page.getByTestId('decisions-pending').getByTestId('decision-card').filter({ hasText: q2 });
    await expect(c2.getByTestId('decision-option')).toHaveCount(0);
    await c2.getByTestId('decision-text').fill('Go with plan B');
    await c2.getByTestId('decision-send').click();
    await expect(page.getByTestId('decisions-history').getByTestId('decision-card').filter({ hasText: q2 })).toContainText('Go with plan B');

    // the answers reached the API, where the coordinator reads them
    const all = (await (await page.request.get('/api/decisions')).json()) as { id: string; status: string; answer: string | null }[];
    expect(all.find((d) => d.id === id1)).toMatchObject({ status: 'answered', answer: 'Blue' });
    expect(all.find((d) => d.id === id2)).toMatchObject({ status: 'answered', answer: 'Go with plan B' });
    await noHorizontalScroll(page);
    expect(errors).toEqual([]);
  });

  test('cancels a question', async ({ loggedIn: page }, info) => {
    const q = `Cancel me (${info.project.name} ${Date.now()})`;
    await askDecision(page, `e2e-cancel-${info.project.name}`, { question: q });
    await page.goto('/decisions');
    const card = page.getByTestId('decision-card').filter({ hasText: q });
    await card.getByTestId('decision-cancel').click();
    await card.getByTestId('decision-cancel-confirm').click();
    await expect(page.getByTestId('decisions-history').getByTestId('decision-card').filter({ hasText: q })).toContainText('Cancelled');
  });
});

test.describe('settings and layout', () => {
  test('creates and revokes an agent token, and saves the governor limits', async ({ loggedIn: page }, info) => {
    const errors = trackConsoleErrors(page);
    const name = `e2e-settings-${info.project.name}`;
    await page.goto('/settings');
    await expect(page.getByTestId('settings-factory-tokens')).toBeVisible();
    await page.getByTestId('agent-token-name').fill(name);
    await page.getByTestId('agent-token-create').click();
    const token = (await page.getByTestId('agent-token-value').textContent())!.trim();
    expect(token).toMatch(/^bba_/);
    const cmd = await page.getByTestId('agent-token-command').textContent();
    expect(cmd).toContain('claude mcp add buildyboy --scope user');
    expect(cmd).toContain(`BUILDYBOY_AGENT_TOKEN=${token}`);
    expect(cmd).toContain(`BUILDYBOY_URL=${process.env.BB_E2E_URL}`);
    expect(cmd).toContain('/cli/bb.ts mcp');
    await noHorizontalScroll(page);
    await page.getByTestId('agent-token-dismiss').click();
    await expect(page.getByTestId('agent-token-value')).toHaveCount(0);
    const row = page.getByTestId('agent-token-row').filter({ hasText: name });
    await expect(row).toContainText('last used never');
    await row.getByTestId('agent-token-revoke').click();
    await row.getByTestId('agent-token-revoke-confirm').click();
    await expect(row).toHaveAttribute('data-revoked', 'true');
    await expect(row).toContainText('revoked');

    await page.locator('#gov-five').fill('90');
    await page.getByTestId('governor-save').click();
    await expect(page.getByTestId('settings-factory-governor').getByRole('status')).toHaveText('Saved');
    await page.reload();
    await expect(page.locator('#gov-five')).toHaveValue('90');
    // put the default back for the other project
    await page.locator('#gov-five').fill('');
    await page.getByTestId('governor-save').click();
    await expect(page.getByTestId('settings-factory-governor').getByRole('status')).toHaveText('Saved');

    await page.getByTestId('digest-send').click();
    await expect(page.getByTestId('settings-factory-digest').getByRole('status').filter({ hasText: 'Sent' })).toBeVisible();
    await expect(page.getByTestId('digest-list').locator('li').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('no horizontal scroll, and the phone nav still fits', async ({ loggedIn: page }) => {
    for (const path of ['/backlog', '/backlog/P4', '/backlog/P3', '/decisions', '/settings']) {
      await page.goto(path);
      await expect(page.getByTestId(/backlog-page|task-page|decisions-page|settings-page/)).toBeVisible();
      await noHorizontalScroll(page);
    }
    if (isPhone(page)) {
      const nav = page.getByRole('navigation', { name: 'Main' });
      const links = nav.getByRole('link');
      expect(await links.count()).toBeGreaterThanOrEqual(7);
      const vw = page.viewportSize()!.width;
      for (const box of await links.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.right).toBeLessThanOrEqual(vw + 0.5);
      }
      await expect(nav.getByRole('link', { name: /Backlog/ })).toBeVisible();
    } else {
      await expect(page.locator('header').getByRole('link', { name: 'Decisions' })).toBeVisible();
      await expect(page.locator('header').getByRole('link', { name: 'Backlog' })).toBeVisible();
    }
  });
});

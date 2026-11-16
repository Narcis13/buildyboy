// Factory projects (SPEC §12.9) on the seeded fixtures (fixtures/factory.ts: shop-api with prefix SH- and autopilot on,
// billing paused, the checkout example/notes without a project), at both viewports. Both projects share one server, so
// a test that writes works on records of its own (named after the viewport) or puts back what it changed.
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

/** Console errors that are not part of the test (expected 4xx, aborted requests while navigating). */
const real = (errors: string[]) => errors.filter((e) => !/Failed to load resource.*(40[0-9]|net::ERR_ABORTED)/.test(e));

test.describe('projects list', () => {
  test('shows the factory projects and the repositories not on it', async ({ loggedIn: page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/projects');
    const shop = page.locator('[data-testid=factory-project-card][data-project=shop-api]');
    await expect(shop).toContainText('Shop API');
    // the runner of its machine is offline in the e2e run, so the conductor holds it
    await expect(shop).toContainText('autopilot held');
    await expect(shop.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /\d+/);
    await expect(shop).toContainText('on the line');
    await expect(shop.getByTestId('card-attention')).toContainText('waits on you');
    const billing = page.locator('[data-testid=factory-project-card][data-project=billing]');
    await expect(billing).toHaveAttribute('data-state', 'paused');
    await expect(billing).toContainText('paused');
    // active before paused
    const keys = await page.getByTestId('factory-projects').getByTestId('factory-project-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
    expect(keys.indexOf('paused')).toBeGreaterThan(keys.lastIndexOf('active'));

    // the notes checkout has no project; shop-api's and billing's checkouts are covered
    const others = page.getByTestId('other-repos');
    await expect(others.getByTestId('other-repo').filter({ hasText: 'notes' })).toBeVisible();
    await expect(others.getByTestId('other-repo').filter({ hasText: 'shop-api' })).toHaveCount(0);
    await noHorizontalScroll(page);

    // "Put on the factory" opens the form prefilled from the checkout
    await others.getByTestId('other-repo').filter({ hasText: 'notes' }).getByTestId('put-on-factory').click();
    await expect(page).toHaveURL(/\/projects\/new\?/);
    await expect(page.getByTestId('np-key')).toHaveValue('notes');
    await expect(page.getByTestId('np-name')).toHaveValue('notes');
    await expect(page.getByTestId('np-repo')).toHaveValue('example/notes');
    await expect(page.getByTestId('np-checkout')).toHaveValue('/home/sysadm/apps/notes');
    await expect(page.getByTestId('np-machine')).not.toHaveValue('');
    await expect(page.getByTestId('np-line')).toHaveValue('factory.json');
    await noHorizontalScroll(page);
    expect(real(errors)).toEqual([]);
  });

  test('creates a project from a prefilled link, saves its setup and deletes it', async ({ loggedIn: page }, info) => {
    const errors = trackConsoleErrors(page);
    const key = `e2e-${info.project.name}`;
    const prefix = isPhone(page) ? 'EPH-' : 'EDT-';
    const q = new URLSearchParams({ key, name: `E2E ${info.project.name}`, repo: `example/${key}`, checkout: `C:\\work\\${key}`, lineFile: 'factory/line.json', idPrefix: prefix });
    await page.goto(`/projects/new?${q}`);
    await expect(page.getByTestId('np-key')).toHaveValue(key);
    await expect(page.getByTestId('np-prefix')).toHaveValue(prefix);
    await expect(page.getByTestId('np-line')).toHaveValue('factory/line.json');
    await page.getByTestId('np-submit').click();

    await expect(page).toHaveURL(new RegExp(`/projects/${key}$`));
    await expect(page.getByTestId('project-header')).toContainText(`E2E ${info.project.name}`);
    await expect(page.getByTestId('project-header')).toContainText(prefix);
    await expect(page.getByTestId('project-header')).toHaveAttribute('data-autopilot', 'off');
    await expect(page.getByTestId('project-line')).toContainText('Nothing on the line');

    // Setup: the prefix can still change (no packages), the overrides go into config
    await page.getByRole('tab', { name: /Setup/ }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${key}\\?tab=setup$`));
    await expect(page.getByTestId('ps-prefix')).not.toHaveAttribute('readonly', '');
    await page.getByTestId('ps-name').fill(`E2E renamed ${info.project.name}`);
    await page.locator('#ps-workers').fill('3');
    await page.getByTestId('ps-approval').selectOption('always');
    await page.getByTestId('ps-model-foreman').fill('off');
    await page.getByTestId('ps-model-review').fill('sonnet');
    await noHorizontalScroll(page);
    await page.getByTestId('ps-save').click();
    await expect(page.getByTestId('project-setup').getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    const saved = (await (await page.request.get(`/api/factory/projects/${key}`)).json()) as { name: string; config: Record<string, unknown> };
    expect(saved.name).toBe(`E2E renamed ${info.project.name}`);
    expect(saved.config).toMatchObject({ limits: { workers: 3 }, integrate: { approval: 'always' }, models: { foreman: null, review: 'sonnet' } });
    await expect(page.getByTestId('project-header')).toContainText(`E2E renamed ${info.project.name}`);

    // a reload shows what was saved
    await page.reload();
    await expect(page.getByTestId('ps-model-foreman')).toHaveValue('off');
    await expect(page.locator('#ps-workers')).toHaveValue('3');

    // Check setup: the server says why nothing was sent
    await page.getByTestId('setup-check').click();
    await expect(page.getByTestId('setup-check-result')).toContainText('Nothing was sent');
    await expect(page.getByTestId('setup-no-line')).toBeVisible();

    // no packages: it can be deleted
    await page.getByTestId('ps-delete').click();
    await page.getByTestId('ps-delete-confirm').click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.locator(`[data-testid=factory-project-card][data-project=${key}]`)).toHaveCount(0);
    expect(real(errors)).toEqual([]);
  });
});

test.describe('project page', () => {
  test('shows the line, the board, the archive, the activity and the setup', async ({ loggedIn: page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/projects/shop-api');
    await expect(page.getByTestId('project-header')).toHaveAttribute('data-autopilot', 'on');
    await expect(page.getByRole('tab', { name: /Line/ })).toHaveAttribute('aria-selected', 'true');

    // Line: stages derived from the status and the gate verdicts, the worker's session, the decision, what is next
    const sh4 = page.locator('[data-testid=line-card][data-task=SH-4]');
    await expect(sh4.getByTestId('stage-stepper')).toHaveAttribute('data-stage', 'build');
    // the stepper shows only the stages of shop-api's line (G4 is off in it); the real stage is the current one
    await expect(sh4.getByTestId('stage-stepper')).toHaveAttribute('data-stages', 'prepare,qa,build,G1,G2,G3,G5,cleanup');
    await expect(sh4.locator('[data-step]')).toHaveCount(8);
    await expect(sh4.locator('[data-step=G4]')).toHaveCount(0);
    await expect(sh4.locator('[data-step=build]')).toHaveAttribute('aria-current', 'step');
    await expect(sh4.locator('[data-step=prepare]')).toHaveAttribute('data-state', 'done');
    // what the conductor waits for, and since when
    await expect(sh4.getByTestId('line-waits')).toContainText("the worker's turn to end");
    await expect(sh4.getByTestId('line-waits')).toContainText(/since \d+m ago/);
    await expect(sh4.getByTestId('line-session')).toHaveAttribute('href', /^\/s\/1{8}-/);
    const sh5 = page.locator('[data-testid=line-card][data-task=SH-5]');
    await expect(sh5.getByTestId('stage-stepper')).toHaveAttribute('data-stage', 'G3');
    await expect(sh5.locator('[data-step=G1]')).toHaveAttribute('data-state', 'done');
    await expect(sh5.locator('[data-step=G3]')).toHaveAttribute('aria-current', 'step');
    await expect(sh5.getByTestId('line-round')).toContainText('Round 1 of');
    await expect(sh5.getByTestId('line-waits')).toContainText('Waits on you');
    await expect(sh5.locator('[data-step=G4]')).toHaveCount(0);
    // autopilot is on but held: the header says why
    await expect(page.getByTestId('project-header')).toContainText('autopilot held');
    await expect(page.getByTestId('autopilot-held')).toContainText(/Autopilot held: the runner on .+ is offline/);
    // recent plans, a failed one with its reason
    const failed = page.getByTestId('project-plans').locator('[data-testid=plan-row][data-status=failed]');
    await expect(failed).toContainText('saved payment methods');
    await expect(failed.getByTestId('plan-why')).toContainText('could not read the checkout');
    await expect(page.getByTestId('project-decisions').getByTestId('decision-card')).toContainText('Require two-factor sign-in');
    await expect(page.getByTestId('project-next').getByTestId('task-card').filter({ hasText: 'Login audit trail' })).toBeVisible();
    await noHorizontalScroll(page);

    // Backlog: this project's board, archived packages left out, a link to the archive
    await page.getByRole('tab', { name: /Backlog/ }).click();
    await expect(page).toHaveURL(/\?tab=backlog$/);
    const tab = page.getByTestId('project-tab-backlog');
    await expect(tab.getByTestId('task-card').filter({ hasText: 'Remember-me cookie' })).toBeVisible();
    await expect(tab.getByTestId('task-card').filter({ hasText: 'Login form' })).toHaveCount(0);
    await expect(tab.getByTestId('task-card').filter({ hasText: 'Stock movements' })).toHaveCount(0);
    await expect(tab.getByTestId('archive-link')).toContainText('2 archived');
    await noHorizontalScroll(page);

    // Done: the archive with totals
    await tab.getByTestId('archive-link').click();
    await expect(page).toHaveURL(/\?tab=done$/);
    const rows = page.getByTestId('done-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Rate limiting on /login' })).toContainText('2 rounds');
    await expect(rows.filter({ hasText: 'Rate limiting on /login' })).toContainText('$4.15');
    await expect(page.getByTestId('done-totals')).toContainText('2 archived');
    await expect(page.getByTestId('done-totals')).toContainText('$6.55');
    await expect(page.getByTestId('archive-done')).toBeEnabled();
    await noHorizontalScroll(page);

    // Activity: what the old checkout page showed, for the project's checkout
    await page.getByRole('tab', { name: /Activity/ }).click();
    await expect(page.getByTestId('project-sessions')).toContainText('Add rate limiting to login');
    await expect(page.getByTestId('project-commits')).toContainText('Add login rate limiting');
    await expect(page.getByTestId('project-progress')).toContainText('Open the PR');
    await expect(page.getByTestId('project-cost-chart').locator('svg')).toBeVisible();
    await noHorizontalScroll(page);

    // Setup: where the line runs, the prefix fixed (it has packages), the seeded overrides
    await page.getByRole('tab', { name: /Setup/ }).click();
    await expect(page.getByTestId('ps-prefix')).toHaveValue('SH-');
    await expect(page.getByTestId('ps-prefix')).toHaveAttribute('readonly', '');
    await expect(page.getByTestId('ps-checkout')).toHaveValue('C:\\work\\shop-api');
    await expect(page.locator('#ps-workers')).toHaveValue('2');
    await expect(page.getByTestId('ps-model-visual')).toHaveValue('sonnet');
    await expect(page.getByTestId('setup-legacy')).toHaveCount(0);
    await noHorizontalScroll(page);

    // billing came from the per-repo config: its allocation fields are there
    await page.goto('/projects/billing?tab=setup');
    await expect(page.getByTestId('ps-db')).toHaveValue('bill_');
    await expect(page.getByTestId('ps-cleanup')).toHaveValue('dropdb {db}');
    await page.goto('/projects/billing');
    await expect(page.getByTestId('project-blocked').getByTestId('task-card').filter({ hasText: 'Credit notes' })).toBeVisible();
    await expect(page.getByTestId('project-line')).toContainText('paused');
    expect(real(errors)).toEqual([]);
  });

  test('autopilot, pause, archive done, decisions on the line, archive and unarchive', async ({ loggedIn: page }, info) => {
    const errors = trackConsoleErrors(page);
    const headers = { 'x-bb-csrf': await csrf(page) };
    const key = `act-${info.project.name}`;
    const res = await page.request.post('/api/factory/projects', { headers, data: { key, name: `Actions ${info.project.name}` } });
    expect(res.status(), await res.text()).toBe(201);
    const work = `ACT-W-${info.project.name}`;
    const done = `ACT-D-${info.project.name}`;
    for (const t of [{ id: work, title: `Work on ${info.project.name}`, status: 'gata' }, { id: done, title: `Done on ${info.project.name}`, status: 'integrata' }]) {
      const r = await page.request.post('/api/tasks', { headers, data: { project: key, ...t } });
      expect(r.status(), await r.text()).toBe(201);
    }
    await page.request.put(`/api/tasks/${work}`, { headers, data: { status: 'in_lucru' } });
    // a question about it, asked the way the conductor or a coordinator does
    const tok = await page.request.post('/api/agent-tokens', { data: { name: `e2e-line-${info.project.name}` }, headers });
    const { token } = (await tok.json()) as { token: string };
    const question = `Keep the old endpoint? (${info.project.name})`;
    const ask = await page.request.post('/api/agent/decision_ask', { data: { taskId: work, question, options: ['Keep it', 'Drop it'] }, headers: { authorization: `Bearer ${token}` } });
    expect(ask.ok(), await ask.text()).toBe(true);

    await page.goto(`/projects/${key}`);
    const header = page.getByTestId('project-header');
    // autopilot
    const sw = page.getByTestId('autopilot-switch').getByRole('switch');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.click();
    await expect(header).toHaveAttribute('data-autopilot', 'on');
    // this project has no machine, so the conductor holds it: autopilot is on, but held, and the header says why
    await expect(header).toContainText('autopilot held');
    await expect(header.getByTestId('autopilot-held')).toContainText('Autopilot held: set the machine and the main checkout');
    // the decision is answered on the line
    const card = page.getByTestId('project-decisions').getByTestId('decision-card').filter({ hasText: question });
    await expect(page.locator(`[data-testid=line-card][data-task=${work}]`).getByTestId('line-waits')).toContainText('Waits on you');
    await card.getByTestId('decision-option').filter({ hasText: 'Drop it' }).click();
    await expect(page.getByTestId('project-decisions')).toHaveCount(0);
    // pause and resume
    await page.getByTestId('project-pause').click();
    await expect(header).toHaveAttribute('data-state', 'paused');
    await expect(header).toContainText('autopilot held');
    await expect(header.getByTestId('autopilot-held')).toContainText('the project is paused');
    await page.getByTestId('project-resume').click();
    await expect(header).toHaveAttribute('data-state', 'active');
    await noHorizontalScroll(page);

    // Archive done on the Done tab
    await page.getByRole('tab', { name: /Done/ }).click();
    await expect(page.getByTestId('done-row')).toHaveCount(0);
    await page.getByTestId('archive-done').click();
    await expect(page.getByTestId('archive-done-result')).toContainText(done);
    await expect(page.locator(`[data-testid=done-row][data-task=${done}]`)).toBeVisible();
    await expect(page.getByTestId('archive-done')).toBeDisabled();

    // archive the project (confirmed), then bring it back
    await page.getByTestId('project-archive').click();
    await page.getByTestId('project-archive-confirm-yes').click();
    await expect(header).toHaveAttribute('data-state', 'archived');
    await expect(page.getByTestId('autopilot-switch').getByRole('switch')).toBeDisabled();
    await page.goto('/projects');
    await expect(page.locator(`[data-testid=factory-projects] [data-project=${key}]`)).toHaveCount(0);
    await page.getByTestId('toggle-archived').click();
    await page.getByTestId('archived-projects').locator(`[data-project=${key}]`).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${key}$`));
    await page.getByTestId('project-unarchive').click();
    await expect(page.getByTestId('project-header')).toHaveAttribute('data-state', 'active');
    // the package archived with the project is back on the board; the one archived before stays archived
    const tasks = (await (await page.request.get(`/api/tasks?project=${key}`)).json()) as { id: string }[];
    expect(tasks.map((t) => t.id)).toEqual([work]);
    // leave it archived, autopilot off, so it stays out of the other tests' way
    await page.request.post(`/api/factory/projects/${key}/autopilot`, { headers, data: { on: false } });
    await page.request.post(`/api/factory/projects/${key}/archive`, { headers });
    expect(real(errors)).toEqual([]);
  });
});

test.describe('backlog by project and the package page', () => {
  test('switches projects, creates a package in one, archives and unarchives it', async ({ loggedIn: page }, info) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/backlog');
    const switcher = page.getByTestId('project-switcher');
    await expect(switcher.getByTestId('switch-all')).toHaveAttribute('aria-current', 'page');
    await expect(switcher.getByTestId('switch-billing')).toContainText('paused');
    // "All" mixes projects, so cards name theirs
    await expect(page.locator('[data-testid=task-card][data-task=SH-5]').getByTestId('task-card-project')).toHaveText('shop-api');

    await switcher.getByTestId('switch-shop-api').click();
    await expect(page).toHaveURL(/\/backlog\?project=shop-api$/);
    await expect(switcher.getByTestId('switch-shop-api')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-testid=task-card][data-task=SH-7]')).toBeVisible();
    await expect(page.locator('[data-testid=task-card][data-task=P4]')).toHaveCount(0);
    await expect(page.locator('[data-testid=task-card][data-task=SH-1]')).toHaveCount(0); // archived
    await expect(page.getByTestId('task-card-project')).toHaveCount(0);
    await expect(page.getByTestId('archive-link')).toHaveText('2 archived');
    await expect(page.getByTestId('archive-link')).toHaveAttribute('href', '/projects/shop-api?tab=done');
    await noHorizontalScroll(page);

    // the switcher survives a reload (it is in the URL), and preselects the project in the forms
    await page.reload();
    await page.getByTestId('new-task-open').click();
    await expect(page.getByTestId('nt-project')).toHaveValue('shop-api');
    const local = `N-${info.project.name}`;
    await page.getByTestId('nt-title').fill(`Switcher package on ${info.project.name}`);
    await page.getByTestId('nt-id').fill(local);
    await page.getByTestId('nt-submit').click();
    const id = `SH-${local}`;
    await expect(page).toHaveURL(new RegExp(`/backlog/${id}$`));
    await expect(page.getByTestId('task-local-id')).toHaveText(`local ${local}`);
    await expect(page.getByTestId('task-project-link')).toHaveText('Shop API');

    // archive: it leaves the board; unarchive: it is back
    await page.getByTestId('task-archive').click();
    await expect(page.getByTestId('task-archived')).toBeVisible();
    await page.goto('/backlog?project=shop-api');
    await expect(page.locator('[data-testid=archive-link]')).toHaveText('3 archived');
    await expect(page.locator(`[data-testid=task-card][data-task=${id}]`)).toHaveCount(0);
    await page.goto(`/backlog/${id}`);
    await page.getByTestId('task-unarchive').click();
    await expect(page.getByTestId('task-archived')).toHaveCount(0);
    await expect(page.getByTestId('task-archive')).toBeVisible();
    await page.goto('/backlog?project=shop-api');
    if (isPhone(page)) await page.getByTestId('filter-backlog').click();
    await expect(page.locator(`[data-testid=task-card][data-task=${id}]`)).toBeVisible();

    // packages without a project
    await page.getByTestId('switch-none').click();
    await expect(page).toHaveURL(/\?project=none$/);
    if (isPhone(page)) await page.getByTestId('filter-all').click();
    await expect(page.locator('[data-testid=task-card][data-task=P4]')).toBeVisible();
    await expect(page.locator('[data-testid=task-card][data-task=SH-7]')).toHaveCount(0);

    // the import form takes the switcher's project too
    await page.goto('/backlog?project=billing');
    await page.getByTestId('import-open').click();
    await expect(page.getByTestId('imp-project')).toHaveValue('billing');
    await expect(page.locator('#imp-owner')).toHaveValue('example');
    expect(real(errors)).toEqual([]);
  });

  test('the package page shows the project, the local id and the stage', async ({ loggedIn: page }) => {
    await page.goto('/backlog/SH-5');
    await expect(page.getByTestId('task-local-id')).toHaveText('local 5');
    await expect(page.getByTestId('task-stage')).toHaveAttribute('data-stage', 'G3');
    await expect(page.getByTestId('task-stage')).toContainText('from the status');
    // the project's line has no G4
    await expect(page.getByTestId('task-stage').locator('[data-step]')).toHaveCount(8);
    await expect(page.getByTestId('task-stage').locator('[data-step=G4]')).toHaveCount(0);
    await noHorizontalScroll(page);
    await page.getByTestId('task-project-link').click();
    await expect(page).toHaveURL(/\/projects\/shop-api$/);
    // a package without a project has no local id and no stage off the line
    await page.goto('/backlog/P7');
    await expect(page.getByTestId('task-local-id')).toHaveCount(0);
    await expect(page.getByTestId('task-stage')).toHaveCount(0);
    await expect(page.getByTestId('task-project')).toHaveText('—');
  });

  test('the package page shows what the conductor waits for and its line history', async ({ loggedIn: page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/backlog/SH-4');
    const stage = page.getByTestId('task-stage');
    await expect(stage).toHaveAttribute('data-stage', 'build');
    await expect(stage).not.toContainText('from the status'); // the conductor's own stage
    await expect(stage.locator('[data-step=G4]')).toHaveCount(0);
    await expect(page.getByTestId('task-line-wait')).toContainText("Waits: the worker's turn to end");
    await expect(page.getByTestId('task-line-wait')).toContainText(/since \d+m ago/);
    // history: the conductor's sentences, and readable lines for its steps
    const lines = page.locator('[data-testid=history-item][data-kind=line]');
    await expect(lines.first()).toContainText('The worker started in terminal bb-SH-4. Waiting for its turn to end.');
    await expect(lines.filter({ hasText: 'Claimed SH-4: port 4101' })).toHaveCount(1);
    await expect(page.locator('[data-testid=history-item][data-kind=step_run]')).toContainText('started step prepare, round 1');
    await expect(page.locator('[data-testid=history-item][data-kind=step]')).toContainText('step prepare pass: worktree ready');
    await noHorizontalScroll(page);
    expect(real(errors)).toEqual([]);
  });
});

test.describe('plan new work', () => {
  test('starts a plan from the header: the goal is required, the plan shows as running', async ({ loggedIn: page }, info) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/projects/shop-api');
    await page.getByTestId('plan-open').click();
    const form = page.getByTestId('plan-form');
    await expect(form).toBeVisible();
    await noHorizontalScroll(page);
    // an empty goal is held back in the browser
    let posted = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/plan$/.test(r.url())) posted++;
    });
    await page.getByTestId('plan-submit').click();
    await expect(page.getByTestId('plan-goal-error')).toBeVisible();
    expect(posted).toBe(0);
    // cancel closes it
    await page.getByTestId('plan-cancel').click();
    await expect(form).toHaveCount(0);
    await page.getByTestId('plan-open').click();

    const goal = `Add a wish list to the shop (${info.project.name})`;
    await page.getByTestId('plan-goal').fill(goal);
    await page.getByTestId('plan-notes').fill('Keep it to signed-in customers.');
    await page.getByTestId('plan-submit').click();
    await expect(form).toHaveCount(0);
    const row = page.getByTestId('project-plans').locator('[data-testid=plan-row]').filter({ hasText: goal });
    await expect(row).toHaveAttribute('data-status', 'running');
    await expect(row).toContainText('running');
    expect(posted).toBe(1);
    await noHorizontalScroll(page);
    expect(real(errors)).toEqual([]);
  });

  test('a project without a machine: the server says why, inline; the empty line has its own button', async ({ loggedIn: page }, info) => {
    const errors = trackConsoleErrors(page);
    const headers = { 'x-bb-csrf': await csrf(page) };
    const key = `plan-${info.project.name}`;
    const res = await page.request.post('/api/factory/projects', { headers, data: { key, name: `Plan ${info.project.name}` } });
    expect(res.status(), await res.text()).toBe(201);
    await page.goto(`/projects/${key}`);
    await expect(page.getByTestId('project-line')).toContainText('Nothing on the line');
    await page.getByTestId('line-plan').click();
    await expect(page.getByTestId('plan-form')).toBeVisible();
    await page.getByTestId('plan-goal').fill('Build the first feature');
    await page.getByTestId('plan-submit').click();
    await expect(page.getByTestId('plan-error')).toContainText('needs a machine and the main checkout');
    await expect(page.getByTestId('plan-form')).toBeVisible();
    await noHorizontalScroll(page);
    await page.getByTestId('plan-cancel').click();
    await expect(page.getByTestId('plan-form')).toHaveCount(0);
    // an archived project takes no new plan
    await page.request.post(`/api/factory/projects/${key}/archive`, { headers });
    await page.reload();
    await expect(page.getByTestId('project-header')).toHaveAttribute('data-state', 'archived');
    await expect(page.getByTestId('plan-open')).toHaveCount(0);
    await expect(page.getByTestId('line-plan')).toHaveCount(0);
    await page.request.post(`/api/factory/projects/${key}/unarchive`, { headers });
    await page.request.delete(`/api/factory/projects/${key}`, { headers });
    expect(real(errors)).toEqual([]);
  });
});

test('Settings → Factory keeps only the global values', async ({ loggedIn: page }) => {
  const errors = trackConsoleErrors(page);
  const before = (await (await page.request.get('/api/factory/config')).json()) as { maxRounds: number; repos: { repo: string }[] };
  await page.goto('/settings');
  const card = page.getByTestId('settings-factory-config');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('fc-repo-block')).toHaveCount(0);
  await expect(card.getByTestId('fc-add')).toHaveCount(0);
  await expect(card.getByTestId('fc-projects-link')).toHaveAttribute('href', '/projects');
  await expect(page.locator('#fc-archive-hours')).toHaveValue('24');
  await page.locator('#fc-max-rounds').fill('4');
  await page.locator('#fc-archive-hours').fill('48');
  await noHorizontalScroll(page);
  await card.getByTestId('fc-save').click();
  await expect(card.getByRole('status')).toHaveText('Saved');
  const after = (await (await page.request.get('/api/factory/config')).json()) as { maxRounds: number; repos: { repo: string }[] };
  expect(after.maxRounds).toBe(4);
  // the per-repo config (billing's legacy fields) is untouched
  expect(after.repos).toEqual(before.repos);
  expect(((await (await page.request.get('/api/settings')).json()) as { archive_done_after_hours: number }).archive_done_after_hours).toBe(48);
  // put the defaults back for the other project
  await page.locator('#fc-max-rounds').fill(String(before.maxRounds));
  await page.locator('#fc-archive-hours').fill('24');
  await card.getByTestId('fc-save').click();
  await expect(card.getByRole('status')).toHaveText('Saved');
  expect(real(errors)).toEqual([]);
});

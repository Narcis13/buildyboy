// The kit in the runner (SPEC §12.4) against real temporary git repositories: a bare "origin", a main checkout with a
// factory.json whose commands are small node scripts, and the worktree the kit creates. Verifiers are a fake `claude`
// (fixtures/fake-claude-json.mjs) and herdr a fake `hc` (fixtures/fake-hc.mjs). Nothing here touches a real claude, a
// real herdr or this repository; the only processes stopped are ones these tests start.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateCommand, GateReport, StepName } from '../shared/factory.ts';
import { readLine, runGate, type GateDeps } from '../runner/gate.ts';
import { factoryPath, writeFactoryFiles } from '../runner/kit/exec.ts';
import { stopLeftovers } from '../runner/kit/procs.ts';
import { checkTerminal, runHcCommand } from '../runner/herdr.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SLOW = 180_000;

let tmp: string;
let origin: string;
let checkout: string;
let port: number;
const saved: Record<string, string | undefined> = {};

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const wtOf = (id: string) => join(tmp, 'co-wt', id);

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

const SCRIPTS: Record<string, string> = {
  'scripts/setup.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('setup.txt', 'ok ' + process.env.APP_PORT);\nconsole.log('setup done');\n",
  'scripts/verify.mjs':
    "import { existsSync } from 'node:fs';\nif (existsSync('fail.txt')) { console.log('Tests  2 passed, 1 failed (3)'); console.log('Error: expected 1 to be 2'); process.exit(1); }\nconsole.log('Tests  3 passed (3)');\n",
  'scripts/acc.mjs':
    "import { existsSync } from 'node:fs';\nconst id = process.argv[2];\nif (!existsSync('feature.txt')) { console.log(id + ': 1 failed'); process.exit(1); }\nconsole.log(id + ': 1 passed');\n",
  'scripts/shots.mjs':
    "import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';\nconst dir = 'test-results/shots/' + process.argv[2];\nrmSync(dir, { recursive: true, force: true });\nif (existsSync('ui.txt')) {\n  mkdirSync(dir, { recursive: true });\n  const png = Buffer.from(process.env.PNG_B64, 'base64');\n  writeFileSync(dir + '/home-phone.png', png);\n  writeFileSync(dir + '/home-desktop.png', png);\n}\n",
  'scripts/app.mjs': "import { createServer } from 'node:http';\ncreateServer((q, r) => r.end('ok')).listen(Number(process.env.APP_PORT), '127.0.0.1');\n",
  'scripts/cleanup.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('cleaned-' + process.argv[2] + '.txt', 'x');\n",
};

const LINE = {
  commands: {
    setup: 'node scripts/setup.mjs', verify: 'node scripts/verify.mjs', acceptance: 'node scripts/acc.mjs {localId}', shots: 'node scripts/shots.mjs {localId}',
    app: 'node scripts/app.mjs', cleanup: 'node scripts/cleanup.mjs {id}',
  },
  env: { APP_PORT: '{port}', PNG_B64: PNG.toString('base64') },
  paths: { protected: ['config/'] },
  app: { readyPath: '/health', readyTimeoutSec: 20 },
};

beforeAll(async () => {
  for (const k of ['BUILDYBOY_CLAUDE_BIN', 'BUILDYBOY_HC', 'FAKE_CLAUDE_SCRIPT', 'FAKE_CLAUDE_LOG', 'FAKE_HC_TERMINALS', 'FAKE_HC_LOG']) saved[k] = process.env[k];
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bb-kit-')));
  port = await freePort();
  origin = join(tmp, 'origin.git');
  checkout = join(tmp, 'co');
  git(['init', '--bare', '-q', '-b', 'main', origin], tmp);
  git(['init', '-q', '-b', 'main', checkout], tmp);
  for (const [k, v] of [['user.name', 'Kit Test'], ['user.email', 'kit@example.test'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) git(['config', k, v], checkout);
  for (const [p, c] of Object.entries(SCRIPTS)) {
    mkdirSync(dirname(join(checkout, p)), { recursive: true });
    writeFileSync(join(checkout, p), c);
  }
  writeFileSync(join(checkout, 'factory.json'), JSON.stringify(LINE, null, 2));
  writeFileSync(join(checkout, '.gitignore'), 'setup.txt\ntest-results/\ncleaned-*.txt\n');
  writeFileSync(join(checkout, 'shared.txt'), 'base\n');
  git(['add', '-A'], checkout);
  git(['commit', '-q', '-m', 'init'], checkout);
  git(['remote', 'add', 'origin', origin], checkout);
  git(['push', '-q', '-u', 'origin', 'main'], checkout);
  process.env.BUILDYBOY_CLAUDE_BIN = join(FIX, 'fake-claude-json.mjs');
  process.env.BUILDYBOY_HC = join(FIX, 'fake-hc.mjs');
  process.env.FAKE_HC_LOG = join(tmp, 'hc.log');
  process.env.FAKE_HC_TERMINALS = join(tmp, 'terminals.json');
  writeFileSync(process.env.FAKE_HC_TERMINALS, JSON.stringify([{ address: 't9', name: 'bb-p1', cwd: wtOf('P1'), status: 'idle', labels: { owner: 'buildyboy', 'bb.task': 'P1' } }]));
}, SLOW);

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows may hold files briefly
  }
});

type Run = GateCommand['run'];
function command(gate: StepName, over: Partial<Run> = {}, id = 'P1'): Run {
  return {
    id: randomUUID(), taskId: id, gate, round: 1, args: [], checkout, recipe: 'factory.json',
    vars: { id, idLower: id.toLowerCase(), worktree: '', round: '1', port: String(port), db: '' },
    project: 'demo',
    task: { id, localId: id, title: `Feature ${id}`, body: 'Build the feature.', acceptance: ['C1: the feature file exists'], sensitive: false, branch: null },
    resources: { port, db: `demo_${id.toLowerCase()}`, migrations: null },
    ...over,
  };
}

async function step(gate: StepName, over: Partial<Run> = {}, id = 'P1'): Promise<GateReport & { posts: GateReport[] }> {
  const posts: GateReport[] = [];
  const deps: GateDeps = { allowedRoots: [tmp], api: { post: async (_p: string, b: unknown) => void posts.push(b as GateReport) }, log: () => {}, retry: { initialMs: 1, maxMs: 1, totalMs: 1 } };
  const r = await runGate(command(gate, over, id), deps);
  return { ...r, posts };
}

/** a scripted fake claude for the next verifier runs; returns a reader of its calls */
function claudeScript(responses: unknown[]) {
  const file = join(tmp, `script-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ responses }));
  process.env.FAKE_CLAUDE_SCRIPT = file;
  process.env.FAKE_CLAUDE_LOG = `${file}.log`;
  return () => (existsSync(`${file}.log`) ? readFileSync(`${file}.log`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; cwd: string; env: Record<string, string>; prompt: string }) : []);
}
const flagValues = (argv: string[], flag: string) => {
  const i = argv.indexOf(flag);
  const out: string[] = [];
  for (let j = i + 1; i >= 0 && j < argv.length - 1 && !argv[j].startsWith('--'); j++) out.push(argv[j]); // the last one is the prompt
  return out;
};
const commitIn = (wt: string, files: Record<string, string>, msg: string) => {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, p)), { recursive: true });
    writeFileSync(join(wt, p), c);
  }
  git(['add', '-A'], wt);
  git(['commit', '-q', '-m', msg], wt);
};

describe('the kit, step by step on a real repository', () => {
  it('prepare: worktree and branch from origin/main, env file, .factory/, setup; reports the line; reused the second time', async () => {
    const r = await step('prepare', { files: [{ path: 'brief.md', content: '# Brief\nDo it.' }, { path: '.factory/notes/a.md', content: 'a' }] });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ status: 'done', verdict: 'pass' });
    expect(r.summary).toMatch(/^prepare: created .*co-wt.*P1 on pkg\/P1 \(\w{12}\); setup ok$/);
    const wt = wtOf('P1');
    expect(git(['symbolic-ref', '--short', 'HEAD'], wt)).toBe('pkg/P1');
    expect(git(['rev-parse', 'HEAD'], wt)).toBe(git(['rev-parse', 'origin/main'], checkout));
    expect(readFileSync(join(wt, '.env.factory'), 'utf8')).toContain(`APP_PORT=${port}`);
    expect(readFileSync(join(wt, 'setup.txt'), 'utf8')).toBe(`ok ${port}`);
    expect(readFileSync(join(wt, '.factory', 'brief.md'), 'utf8')).toBe('# Brief\nDo it.');
    expect(readFileSync(join(wt, '.factory', 'notes', 'a.md'), 'utf8')).toBe('a');
    expect(readFileSync(join(wt, '.factory', 'package.md'), 'utf8')).toContain('# P1: Feature P1\n\nBuild the feature.\n\n## Acceptance criteria\n\n1. C1: the feature file exists');
    const guard = JSON.parse(readFileSync(join(wt, '.factory', 'guard.json'), 'utf8'));
    expect(guard).toMatchObject({ taskId: 'P1', lineFile: 'factory.json', acceptance: 'tests/acceptance/P1' });
    expect(guard.protected).toEqual(expect.arrayContaining(['factory.json', 'tests/acceptance/**', 'config/']));
    expect(git(['status', '--porcelain'], wt)).toBe(''); // .factory/ and the env file stay out of git
    expect(r.line).toMatchObject({ legacy: false, enabled: { G1: true, G2: true, G3: true, G4: true, G5: true }, qa: true });
    expect(r.details).toMatchObject({ branch: 'pkg/P1', base: 'main', created: true });

    const again = await step('prepare');
    expect(again).toMatchObject({ status: 'done', verdict: 'pass', details: { created: false } });
  }, SLOW);

  it('files go only under .factory/: an escaping path refuses the whole set', async () => {
    const r = await step('G1', { files: [{ path: 'ok.md', content: 'x' }, { path: '../escape.txt', content: 'x' }] });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/only paths under \.factory\//);
    expect(existsSync(join(wtOf('P1'), 'escape.txt'))).toBe(false);
    expect(existsSync(join(wtOf('P1'), '.factory', 'ok.md'))).toBe(false);
    const wt = wtOf('P1');
    for (const bad of ['../x', 'a/../../x', '/abs', 'C:\\x', 'a\\..\\..\\x', '..', '.', '', 'a b', '.factory/../x']) expect(factoryPath(wt, bad), bad).toBeNull();
    expect(factoryPath(wt, 'inbox/1.md')).toBe(join(wt, '.factory', 'inbox', '1.md'));
    expect(() => writeFactoryFiles(wt, [{ path: 'x.md', content: 'y' }, { path: '../../z', content: 'y' }])).toThrow(/never outside it/);
  }, SLOW);

  it('qa: claude writes the tests, the kit checks the commit and tags bb-acceptance/<id>', async () => {
    const wt = wtOf('P1');
    const head = git(['rev-parse', 'HEAD'], wt);
    // no commit: fail
    let calls = claudeScript([{ result: 'nothing', cost: 0.1 }]);
    let r = await step('qa');
    expect(r).toMatchObject({ status: 'done', verdict: 'fail' });
    expect(r.summary).toMatch(/no commit/);
    // a commit outside the acceptance folder: fail, no tag
    calls = claudeScript([{ writes: { 'tests/acceptance/P1/c1.test.mjs': 'test', 'src/hack.js': 'x' }, git: [['add', '-A'], ['commit', '-m', 'acceptance: P1']], cost: 0.2 }]);
    r = await step('qa');
    expect(r.verdict).toBe('fail');
    expect(r.summary).toMatch(/outside tests\/acceptance\/P1: src\/hack\.js/);
    expect(() => git(['rev-parse', '--verify', '-q', 'refs/tags/bb-acceptance/P1'], wt)).toThrow();
    git(['reset', '-q', '--hard', head], wt);
    // the good run
    calls = claudeScript([
      { writes: { 'tests/acceptance/P1/c1.test.mjs': "// C1: the feature file exists\n", 'tests/acceptance/P1/MANUAL.md': '# check by hand\n' }, git: [['add', '-A'], ['commit', '-m', 'acceptance: P1']], result: 'C1 covered by c1.test.mjs', cost: 0.75 },
    ]);
    r = await step('qa');
    expect(r).toMatchObject({ status: 'done', verdict: 'pass' });
    expect(r.summary).toMatch(/^QA \(\$0\.75\): 1 test file in tests\/acceptance\/P1 at \w{12}, tag bb-acceptance\/P1; tests\/acceptance\/P1\/MANUAL\.md lists checks/);
    expect(r.details).toMatchObject({ costUsd: 0.75, tag: 'bb-acceptance/P1', files: ['tests/acceptance/P1/c1.test.mjs'], answer: 'C1 covered by c1.test.mjs' });
    expect(git(['rev-parse', 'bb-acceptance/P1'], wt)).toBe(git(['rev-parse', 'HEAD'], wt));
    const [c] = calls();
    expect(c.env).toEqual({ BB_TASK: 'P1', BB_ROLE: 'qa' });
    expect(realpathSync(c.cwd)).toBe(realpathSync(wt));
    expect(flagValues(c.argv, '--permission-mode')).toEqual(['dontAsk']);
    expect(flagValues(c.argv, '--model')).toEqual(['opus']);
    expect(flagValues(c.argv, '--allowedTools')).toEqual(['Read', 'Grep', 'Glob', 'Edit(tests/acceptance/P1/**)', 'Write(tests/acceptance/P1/**)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)']);
    expect(c.argv).not.toContain('--json-schema');
    expect(c.prompt).toContain('Write only under `tests/acceptance/P1`');
    expect(c.prompt).toContain('The tests will be run with: `node scripts/acc.mjs P1`');
    expect(c.prompt).toContain('Package: P1 (Feature P1). Specification: `.factory/package.md`.');
  }, SLOW);

  it('G1: commands.verify in the worktree; the summary has the result lines and, on failure, the first errors', async () => {
    let r = await step('G1');
    expect(r).toMatchObject({ status: 'done', verdict: 'pass' });
    expect(r.summary).toBe('G1 pass. Tests  3 passed (3)');
    writeFileSync(join(wtOf('P1'), 'fail.txt'), 'x');
    r = await step('G1');
    expect(r.verdict).toBe('fail');
    expect(r.summary).toMatch(/^G1 fail \(exit 1\)\. Tests {2}2 passed, 1 failed \(3\)\. First errors: .*Error: expected 1 to be 2/);
    rmSync(join(wtOf('P1'), 'fail.txt'));
  }, SLOW);

  it('G2: the acceptance tests must match the QA tag and other packages\' tests stay untouched; then commands.acceptance', async () => {
    const wt = wtOf('P1');
    let r = await step('G2');
    expect(r.verdict).toBe('fail'); // the feature is not built yet
    expect(r.summary).toMatch(/^G2 fail \(exit 1\)\. P1: 1 failed/);
    commitIn(wt, { 'feature.txt': 'the feature\n', 'ui.txt': 'a page\n' }, 'build the feature');
    r = await step('G2');
    expect(r).toMatchObject({ status: 'done', verdict: 'pass', details: { manual: 'tests/acceptance/P1/MANUAL.md' } });
    expect(r.summary).toMatch(/^G2 pass, the acceptance tests are untouched\. P1: 1 passed For the owner to check by hand: tests\/acceptance\/P1\/MANUAL\.md\.$/);
    // tampering, even uncommitted
    writeFileSync(join(wt, 'tests/acceptance/P1/c1.test.mjs'), '// weakened\n');
    r = await step('G2');
    expect(r.verdict).toBe('fail');
    expect(r.summary).toBe('G2 fail: the acceptance tests of P1 differ from the QA commit (bb-acceptance/P1): tests/acceptance/P1/c1.test.mjs');
    git(['checkout', '--', 'tests/acceptance/P1/c1.test.mjs'], wt);
    writeFileSync(join(wt, 'tests/acceptance/P1/extra.test.mjs'), '// added\n');
    expect((await step('G2')).summary).toMatch(/differ from the QA commit .*extra\.test\.mjs/);
    rmSync(join(wt, 'tests/acceptance/P1/extra.test.mjs'));
    // another package's tests
    commitIn(wt, { 'tests/acceptance/P9/old.test.mjs': 'changed\n' }, 'touch P9');
    r = await step('G2');
    expect(r.summary).toBe("G2 fail: the branch touched other packages' acceptance tests: tests/acceptance/P9/old.test.mjs");
    git(['reset', '-q', '--hard', 'HEAD~1'], wt);
    expect((await step('G2')).verdict).toBe('pass');
  }, SLOW);

  it('G3: the reviewer runs read-only with the schema; findings and the verdict rule; a security pass; earlier findings; one retry', async () => {
    const review = (verdict: string, findings: unknown[]) => ({ structured_output: { verdict, summary: `Review says ${verdict}.`, findings }, cost: 0.4 });
    let calls = claudeScript([
      review('fail', [
        { severity: 'major', category: 'tests', file: 'src/a.js', line: 3, description: 'No test for empty input. It crashes there.', fix: 'Empty input is refused with a message.' },
        { severity: 'minor', category: 'rules', file: 'src/b.js', description: 'A name breaks the convention', fix: 'Rename it.' },
      ]),
    ]);
    let r = await step('G3');
    expect(r).toMatchObject({ status: 'done', verdict: 'fail', details: { costUsd: 0.4, passes: [{ focus: 'general', verdict: 'fail', costUsd: 0.4 }] } });
    expect(r.summary).toBe('G3 fail ($0.40): 0 blocker, 1 major, 1 minor. Review says fail.');
    expect(r.findings).toEqual([
      { severity: 'major', title: 'No test for empty input.', file: 'src/a.js', line: 3, detail: 'tests: No test for empty input. It crashes there.', fix: 'Empty input is refused with a message.' },
      { severity: 'minor', title: 'A name breaks the convention', file: 'src/b.js', detail: 'rules: A name breaks the convention', fix: 'Rename it.' },
    ]);
    let [c] = calls();
    expect(c.env).toEqual({ BB_TASK: 'P1', BB_ROLE: 'poarta' });
    expect(flagValues(c.argv, '--allowedTools')).toEqual(['Read', 'Grep', 'Glob', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)']);
    expect(flagValues(c.argv, '--permission-mode')).toEqual(['dontAsk']);
    expect(flagValues(c.argv, '--max-turns')).toEqual(['60']);
    expect(flagValues(c.argv, '--max-budget-usd')).toEqual(['5']);
    expect(JSON.parse(flagValues(c.argv, '--json-schema')[0]).required).toEqual(['verdict', 'summary', 'findings']);
    expect(c.prompt).toContain('git diff origin/main...HEAD');
    expect(c.prompt).not.toContain('{base}');
    expect(c.prompt).not.toContain('Earlier open findings');

    // only minors: pass, whatever the model's own wording
    claudeScript([review('pass', [{ severity: 'minor', category: 'rules', file: 'x', description: 'Small.', fix: 'f' }])]);
    expect((await step('G3')).verdict).toBe('pass');

    // a sensitive package gets a second, security pass; round 2 lists the earlier open findings
    calls = claudeScript([review('pass', []), review('pass', [])]);
    r = await step('G3', {
      round: 2, task: { id: 'P1', localId: 'P1', title: 'Feature P1', body: 'b', acceptance: [], sensitive: true, branch: null },
      findings: [{ severity: 'major', title: 'No test for empty input.', file: 'src/a.js', line: 3, fix: 'Add it.' }],
    });
    expect(r).toMatchObject({ verdict: 'pass', details: { costUsd: 0.8 } });
    expect(r.summary).toMatch(/^G3 pass \(\$0\.80, with the security review\)/);
    const two = calls();
    expect(two).toHaveLength(2);
    expect(two[0].prompt).not.toContain('**Focus: security.**');
    expect(two[1].prompt).toContain('**Focus: security.**');
    for (const x of two) expect(x.prompt).toMatch(/\*\*Earlier open findings\*\* \(from round 1 or before\)[^]*- \[major\] No test for empty input\. \(src\/a\.js:3\) Fix: Add it\./);

    // no structured_output: retried once
    calls = claudeScript([{ result: 'I forgot the format', cost: 0.1 }, review('pass', [])]);
    expect((await step('G3')).verdict).toBe('pass');
    expect(calls()).toHaveLength(2);
    calls = claudeScript([{ result: 'no', cost: 0.1 }]);
    r = await step('G3');
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/no structured_output .*retried once/);
    expect(calls()).toHaveLength(2);
  }, SLOW);

  it('G4: screenshots, the app on the package\'s port, the visual judge, the shots attached; skip without screenshots', async () => {
    let calls = claudeScript([{ structured_output: { verdict: 'pass', summary: 'Looks right.', findings: [{ shot: 'home-phone.png', rule: 4, severity: 'minor', description: 'Spacing differs. A bit.', fix: 'Use the same spacing.' }] }, cost: 0.3 }]);
    let r = await step('G4');
    expect(r).toMatchObject({ status: 'done', verdict: 'pass', details: { costUsd: 0.3, shots: 2, app: `http://localhost:${port}` } });
    expect(r.summary).toBe('G4 pass ($0.30): 0 blocker, 1 minor, 2 screenshots. Looks right.');
    expect(r.shots?.map((s) => s.name)).toEqual(['home-desktop', 'home-phone']);
    expect(r.findings).toEqual([{ severity: 'minor', title: 'Spacing differs.', file: 'home-phone.png', detail: 'rule 4 · shot home-phone.png · Spacing differs. A bit.', fix: 'Use the same spacing.' }]);
    const [c] = calls();
    expect(flagValues(c.argv, '--model')).toEqual(['sonnet']);
    expect(flagValues(c.argv, '--allowedTools')).toEqual(['Read', 'Glob']);
    expect(c.argv).not.toContain('--chrome');
    expect(c.prompt).toContain(`The app is running at http://localhost:${port}.`);
    expect(c.prompt).toContain('`test-results/shots/P1/home-desktop.png`');
    // the app was stopped
    await expect(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();

    // a minor problem against rule 2 fails the gate
    claudeScript([{ structured_output: { verdict: 'pass', summary: 's', findings: [{ shot: 'home-desktop.png', rule: 2, severity: 'minor', description: 'A translation key shows.', fix: 'f' }] } }]);
    expect((await step('G4')).verdict).toBe('fail');

    // no screenshots: skip, no judge
    calls = claudeScript([{ structured_output: { verdict: 'pass', summary: 's', findings: [] } }]);
    rmSync(join(wtOf('P1'), 'ui.txt'));
    r = await step('G4');
    expect(r).toMatchObject({ verdict: 'skip', summary: 'G4 skip: the package produced no screenshots in test-results/shots/P1' });
    expect(calls()).toHaveLength(0);
    git(['checkout', '--', 'ui.txt'], wtOf('P1'));
  }, SLOW);

  it('G5: protected paths need approval', async () => {
    const wt = wtOf('P1');
    commitIn(wt, { 'factory.json': '{"commands":{}}\n', 'config/x.txt': 'x\n' }, 'touch the line');
    const r = await step('G5');
    expect(r.status).toBe('error');
    expect(r.error).toBe('needs approval: config/x.txt, factory.json');
    git(['reset', '-q', '--hard', 'HEAD~1'], wt);
  }, SLOW);

  it('G5: a conflict is a fail with the files, and the merge is aborted', async () => {
    const wt = wtOf('P1');
    writeFileSync(join(checkout, 'shared.txt'), 'main changed it\n');
    git(['commit', '-q', '-am', 'main side'], checkout);
    git(['push', '-q', 'origin', 'main'], checkout);
    commitIn(wt, { 'shared.txt': 'the branch changed it\n' }, 'branch side');
    const r = await step('G5');
    expect(r).toMatchObject({ status: 'done', verdict: 'fail' });
    expect(r.summary).toBe('G5 fail: merging origin/main into pkg/P1 conflicts in shared.txt; the merge was aborted');
    expect(r.findings).toEqual([{ severity: 'blocker', title: 'Merge conflict with origin/main', file: 'shared.txt', fix: 'merge origin/main into pkg/P1 and resolve the conflict' }]);
    expect(git(['status', '--porcelain'], wt)).toBe('');
    expect(existsSync(join(wt, '.git'))).toBe(true);
    git(['reset', '-q', '--hard', 'HEAD~1'], wt);
  }, SLOW);

  it('G5: G1 failing on the merged result fails the integration and pushes nothing', async () => {
    const wt = wtOf('P1');
    writeFileSync(join(checkout, 'fail.txt'), 'x');
    git(['add', 'fail.txt'], checkout);
    git(['commit', '-q', '-m', 'break main'], checkout);
    git(['push', '-q', 'origin', 'main'], checkout);
    const before = git(['rev-parse', 'main'], origin);
    const r = await step('G5');
    expect(r.verdict).toBe('fail');
    expect(r.summary).toMatch(/^G5 fail: after merging origin\/main, G1 fail \(exit 1\)/);
    expect(git(['rev-parse', 'main'], origin)).toBe(before);
    git(['rm', '-q', 'fail.txt'], checkout);
    git(['commit', '-q', '-m', 'fix main'], checkout);
    git(['push', '-q', 'origin', 'main'], checkout);
    git(['reset', '-q', '--hard', 'HEAD~1'], wt); // drop the merge commit
  }, SLOW);

  let range = '';
  it('G5: merge, G1 and G2 again, fast-forward main, push both; <old>..<new> in the summary and details', async () => {
    const wt = wtOf('P1');
    const old = git(['rev-parse', 'main'], origin);
    const r = await step('G5');
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ status: 'done', verdict: 'pass' });
    const nu = git(['rev-parse', 'main'], origin);
    range = `${old}..${nu}`;
    expect(r.summary).toBe(`G5 pass: P1 integrated into main: ${range}, pushed`);
    expect(r.details).toMatchObject({ range, old, new: nu, pushed: true });
    expect(nu).toBe(git(['rev-parse', 'HEAD'], wt));
    expect(git(['rev-parse', 'pkg/P1'], origin)).toBe(nu);
    expect(git(['rev-parse', 'HEAD'], checkout)).toBe(nu);
    expect(existsSync(join(checkout, 'feature.txt'))).toBe(true);
    // again: nothing to integrate
    expect((await step('G5')).summary).toMatch(/already in origin\/main/);
  }, SLOW);

  it('cleanup: refused while the branch is not integrated', async () => {
    expect((await step('prepare', {}, 'P2')).verdict).toBe('pass');
    commitIn(wtOf('P2'), { 'p2.txt': 'x\n' }, 'P2 work');
    const r = await step('cleanup', {}, 'P2');
    expect(r).toMatchObject({ status: 'done', verdict: 'fail', summary: 'cleanup refused: pkg/P2 is not integrated in origin/main' });
    expect(existsSync(wtOf('P2'))).toBe(true);
  }, SLOW);

  it('cleanup: ends the terminal, removes the worktree and the branch, runs commands.cleanup', async () => {
    writeFileSync(process.env.FAKE_HC_LOG!, '');
    const r = await step('cleanup');
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ status: 'done', verdict: 'pass' });
    expect(r.summary).toBe('cleanup P1: terminal bb-p1 ended; worktree removed; branch pkg/P1 deleted; commands.cleanup ok');
    expect(existsSync(wtOf('P1'))).toBe(false);
    expect(() => git(['rev-parse', '--verify', '-q', 'refs/heads/pkg/P1'], checkout)).toThrow();
    expect(existsSync(join(checkout, 'cleaned-P1.txt'))).toBe(true);
    expect(readFileSync(process.env.FAKE_HC_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([['kill', '--json', 'bb-p1']]);
  }, SLOW);

  it('revert: the G5 range is reverted on main (one commit for a range with merges), G1, push', async () => {
    expect((await step('revert')).error).toMatch(/needs the range/);
    const r = await step('revert', { args: [range] });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ status: 'done', verdict: 'pass', details: { range, pushed: true } });
    expect(r.summary).toMatch(new RegExp(`^revert: ${range.replace('.', '\\.')} reverted on main at \\w{12}, pushed$`));
    expect(existsSync(join(checkout, 'feature.txt'))).toBe(false);
    expect(git(['rev-parse', 'main'], origin)).toBe(git(['rev-parse', 'HEAD'], checkout));
    expect(git(['log', '-1', '--format=%s'], checkout)).toBe(`Revert P1 (${range})`);
  }, SLOW);

  it('accepts today\'s command shape (no task, no project): the package comes from the vars', async () => {
    const r = await step('G1', { task: undefined, project: undefined, resources: undefined, vars: { id: 'P2', idLower: 'p2', worktree: '', round: '1', port: '', db: '' } }, 'P2');
    expect(r).toMatchObject({ status: 'done', verdict: 'pass' });
  }, SLOW);

  it('reads the line for {type: "line"}', () => {
    const r = readLine(checkout, 'factory.json', [tmp]);
    expect(r.ok && r.line.enabled).toEqual({ G1: true, G2: true, G3: true, G4: true, G5: true });
    expect(readLine(checkout, '../x.json', [tmp])).toMatchObject({ ok: false, error: expect.stringMatching(/outside the checkout/) });
    expect(readLine(checkout, 'nope.json', [tmp])).toMatchObject({ ok: false, error: expect.stringMatching(/cannot read/) });
    expect(readLine(checkout, 'factory.json', [join(tmp, 'elsewhere')])).toMatchObject({ ok: false });
  });

  it('a step of a line that is off is a skip; an invalid line is an error', async () => {
    writeFileSync(join(checkout, 'small.json'), JSON.stringify({ commands: { verify: 'node scripts/verify.mjs' } }));
    expect(await step('G4', { recipe: 'small.json' })).toMatchObject({ status: 'done', verdict: 'skip', summary: 'G4 skip: G4 is off in the line' });
    expect(await step('qa', { recipe: 'small.json' })).toMatchObject({ verdict: 'skip' });
    writeFileSync(join(checkout, 'broken.json'), JSON.stringify({ commands: { verfy: 'x' } }));
    const r = await step('prepare', { recipe: 'broken.json' });
    expect(r).toMatchObject({ status: 'error', lineError: 'broken.json: commands: Unrecognized key: "verfy"' });
    // a worktree template that leaves the allowed roots
    writeFileSync(join(checkout, 'far.json'), JSON.stringify({ worktree: join(tmpdir(), 'bb-kit-far-{id}'), commands: { verify: 'x' } }));
    expect((await step('G1', { recipe: 'far.json' })).error).toMatch(/outside the runner's allowed roots/);
  }, SLOW);
});

describe('stopping leftover processes', () => {
  const kids: ChildProcess[] = [];
  afterAll(() => {
    for (const k of kids) if (k.exitCode === null) k.kill();
  });

  it('stops the processes of a worktree and of a port, and not a sibling worktree\'s', async () => {
    const base = join(tmp, 'procs');
    const wt = join(base, 'wt', 'P1');
    const sibling = join(base, 'wt', 'P10');
    for (const d of [wt, sibling]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'keep.mjs'), 'setInterval(() => {}, 1000);\n');
    }
    const p = await freePort();
    const inWt = spawn(process.execPath, [join(wt, 'keep.mjs')], { stdio: 'ignore' });
    const inSibling = spawn(process.execPath, [join(sibling, 'keep.mjs')], { stdio: 'ignore' });
    const onPort = spawn(process.execPath, ['-e', `require('http').createServer().listen(${p}, '127.0.0.1')`], { stdio: 'ignore' });
    kids.push(inWt, inSibling, onPort);
    for (let i = 0; i < 100; i++) {
      const up = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(500) }).then(() => true, (e: Error) => !/ECONNREFUSED|fetch failed/.test(String((e as { cause?: Error }).cause ?? e)) && false);
      if (up) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const exited = (c: ChildProcess) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', () => r())));
    const killed = await stopLeftovers({ worktree: wt, port: p });
    expect(killed).toEqual(expect.arrayContaining([inWt.pid, onPort.pid]));
    expect(killed).not.toContain(inSibling.pid);
    expect(killed).not.toContain(process.pid);
    await Promise.all([exited(inWt), exited(onPort)]);
    expect(inSibling.exitCode).toBeNull();
    expect(await stopLeftovers({ worktree: null, port: 'x; y' })).toEqual([]);
  }, SLOW);
});

describe('checked hc commands', () => {
  const terminals = (list: unknown[]) => writeFileSync(process.env.FAKE_HC_TERMINALS!, JSON.stringify(list));
  const hc = () => ({ command: process.execPath, prefix: [join(FIX, 'fake-hc.mjs')] });
  const logged = () => (existsSync(process.env.FAKE_HC_LOG!) ? readFileSync(process.env.FAKE_HC_LOG!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  it('only a bb-… terminal that hc get shows with that name and owner=buildyboy', async () => {
    const home = join(tmp, 'hc-term');
    mkdirSync(home, { recursive: true });
    terminals([
      { address: 't1', name: 'bb-p7', cwd: home, status: 'idle', labels: { owner: 'buildyboy' } },
      { address: 't2', name: 'bb-mine', cwd: home, labels: { owner: 'someone' } },
      { address: 'bb-alias', name: 'bb-other', cwd: home, labels: { owner: 'buildyboy' } },
      { address: 't3', name: 'w-p7', cwd: home, labels: { owner: 'buildyboy' } },
    ]);
    expect(await checkTerminal(hc(), 'bb-p7')).toMatchObject({ ok: true, name: 'bb-p7', status: 'idle' });
    expect(await checkTerminal(hc(), 'bb-mine')).toMatchObject({ ok: false, reason: expect.stringMatching(/owner=buildyboy/) });
    expect(await checkTerminal(hc(), 'bb-alias')).toMatchObject({ ok: false, reason: expect.stringMatching(/another terminal/) });
    expect(await checkTerminal(hc(), 'w-p7')).toMatchObject({ ok: false, reason: expect.stringMatching(/not a factory terminal/) });
    expect(await checkTerminal(hc(), 'bb-none')).toMatchObject({ ok: false, reason: expect.stringMatching(/no terminal bb-none/) });

    writeFileSync(process.env.FAKE_HC_LOG!, '');
    const roots = [tmp];
    expect(await runHcCommand(hc(), { type: 'hc', id: '1', op: 'send', name: 'bb-p7', text: 'Fix G3: see the findings.' }, roots)).toEqual({ status: 'done', result: { sent: true } });
    expect(await runHcCommand(hc(), { type: 'hc', id: '2', op: 'send', name: 'bb-p7', text: 'only when working', if: 'working' }, roots)).toMatchObject({ status: 'error', error: expect.stringMatching(/not sent: .*not working/) });
    expect(await runHcCommand(hc(), { type: 'hc', id: '3', op: 'send', name: 'bb-p7', text: '-rf', if: 'idle' }, roots)).toEqual({ status: 'done', result: { sent: true } });
    const long = `Findings of round 2:\n${'- a finding\n'.repeat(80)}`;
    expect(await runHcCommand(hc(), { type: 'hc', id: '4', op: 'send', name: 'bb-p7', text: long, files: [{ path: 'findings.json', content: '[]' }] }, roots)).toEqual({ status: 'done', result: { sent: true, inbox: '.factory/inbox/1.md' } });
    expect(readFileSync(join(home, '.factory', 'inbox', '1.md'), 'utf8')).toBe(`${long.trim()}\n`);
    expect(readFileSync(join(home, '.factory', 'findings.json'), 'utf8')).toBe('[]');
    expect((await runHcCommand(hc(), { type: 'hc', id: '5', op: 'send', name: 'bb-p7', text: 'x\ny' }, roots)).result).toEqual({ sent: true, inbox: '.factory/inbox/2.md' });
    expect(await runHcCommand(hc(), { type: 'hc', id: '6', op: 'send', name: 'bb-mine', text: 'hi' }, roots)).toMatchObject({ status: 'error', error: expect.stringMatching(/owner=buildyboy/) });
    expect(await runHcCommand(hc(), { type: 'hc', id: '7', op: 'kill', name: 'bb-mine' }, roots)).toMatchObject({ status: 'error' });
    expect(await runHcCommand(hc(), { type: 'hc', id: '8', op: 'kill', name: 'bb-p7' }, roots)).toEqual({ status: 'done', result: { killed: true } });
    expect(await runHcCommand(hc(), { type: 'hc', id: '9', op: 'send', name: 'bb-p7', text: 'files outside', files: [{ path: '../x', content: 'y' }] }, roots)).toMatchObject({ status: 'error' });
    expect(await runHcCommand(null, { type: 'hc', id: '10', op: 'kill', name: 'bb-p7' }, roots)).toMatchObject({ status: 'error', error: expect.stringMatching(/not installed/) });
    // a terminal whose folder is outside the allowed roots gets no files
    expect(await runHcCommand(hc(), { type: 'hc', id: '11', op: 'send', name: 'bb-p7', text: long }, [join(tmp, 'elsewhere')])).toMatchObject({ status: 'error', error: expect.stringMatching(/not usable/) });
    expect(logged()).toEqual([
      ['send', '--json', 'bb-p7', 'Fix G3: see the findings.'],
      ['send', '--json', '--if', 'idle', 'bb-p7', 'Message: -rf'],
      ['send', '--json', 'bb-p7', 'Read .factory/inbox/1.md: a message from the factory. Act on it, then go on.'],
      ['send', '--json', 'bb-p7', 'Read .factory/inbox/2.md: a message from the factory. Act on it, then go on.'],
      ['kill', '--json', 'bb-p7'],
    ]);
  }, SLOW);
});

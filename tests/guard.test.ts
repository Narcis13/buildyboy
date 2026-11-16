// The plugin's guard (SPEC §12.8): spawns the real plugin/hooks/bb-guard.mjs with hook input on stdin, against a worktree
// with a .factory/guard.json in the shape runner/kit/steps.ts writes, and checks every decision and every fail-open case.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GUARD = join(import.meta.dirname, '..', 'plugin', 'hooks', 'bb-guard.mjs');
const WIN = process.platform === 'win32';
const FOLDS = WIN || process.platform === 'darwin';

let base: string;
let wt: string;
let elsewhere: string;

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
  decision: { permissionDecision?: string; permissionDecisionReason?: string } | null;
}

function runGuard(input: unknown, env: Record<string, string | undefined> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const full: Record<string, string | undefined> = { ...process.env, BB_TASK: 'P1', BB_ROLE: 'lucrator', ...env };
    for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
    const p = spawn(process.execPath, [GUARD], { env: full as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => {
      let decision = null;
      try {
        decision = stdout ? JSON.parse(stdout).hookSpecificOutput : null;
      } catch {
        decision = null;
      }
      resolve({ stdout, stderr, code, ms: Date.now() - t0, decision });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

const write = (file_path: string, cwd = wt) => ({ session_id: 's1', hook_event_name: 'PreToolUse', cwd, tool_name: 'Write', tool_input: { file_path, content: 'x' } });

async function expectDenied(input: unknown, env: Record<string, string | undefined> = {}, mention?: RegExp) {
  const r = await runGuard(input, env);
  expect(r.code).toBe(0);
  expect(r.decision?.permissionDecision, `expected a deny for ${JSON.stringify(input)}`).toBe('deny');
  expect(r.decision?.permissionDecisionReason).toMatch(/^Buildyboy guard: /);
  if (mention) expect(r.decision?.permissionDecisionReason).toMatch(mention);
  return r;
}

async function expectSilent(input: unknown, env: Record<string, string | undefined> = {}) {
  const r = await runGuard(input, env);
  expect(r.code).toBe(0);
  expect(r.stdout, `expected no output for ${JSON.stringify(input)}`).toBe('');
  return r;
}

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'bb-guard-')));
  wt = join(base, 'shop-wt', 'P1');
  elsewhere = join(base, 'elsewhere');
  for (const d of ['.factory', 'src', 'tests/acceptance/P1', 'tests/acceptance/P2', 'config', 'db/sub']) mkdirSync(join(wt, d), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(wt, 'factory.json'), '{}');
  // the shape guardJson() in runner/kit/steps.ts writes for paths.protected ["config/", "db/*.sql", "secrets.txt"]
  writeFileSync(
    join(wt, '.factory', 'guard.json'),
    `${JSON.stringify({
      version: 1,
      taskId: 'P1',
      lineFile: 'factory.json',
      acceptance: 'tests/acceptance/P1',
      protected: ['factory.json', 'secrets.txt', 'tests/acceptance/**', 'config/**', 'secrets.txt/**', 'config/', 'db/*.sql', 'secrets.txt'],
      qaRole: 'qa',
    }, null, 2)}\n`,
  );
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('the guard blocks a worker', () => {
  it('in its own acceptance folder, relative and absolute', async () => {
    await expectDenied(write('tests/acceptance/P1/login.spec.ts'), {}, /acceptance tests \(tests\/acceptance\/P1\/\).*G2/);
    await expectDenied(write(join(wt, 'tests', 'acceptance', 'P1', 'login.spec.ts')));
    await expectDenied(write('tests/acceptance/P1'));
  });

  it("in another package's acceptance tests", async () => {
    await expectDenied(write('tests/acceptance/P2/old.spec.ts'), {}, /another package's acceptance test/);
  });

  it('on the line file, with what to do instead', async () => {
    const r = await expectDenied(write(join(wt, 'factory.json')), {}, /line file/);
    expect(r.decision!.permissionDecisionReason).toContain('FACTORY-STATUS: question');
  });

  it('on every kind of path listed in paths.protected', async () => {
    await expectDenied(write('config/app.json'), {}, /paths\.protected: config/);
    await expectDenied(write('db/001_init.sql'), {}, /paths\.protected: db\/\*\.sql/);
    await expectDenied(write('secrets.txt'), {}, /paths\.protected: secrets\.txt/);
  });

  it('on the guard file itself', async () => {
    await expectDenied(write('.factory/guard.json'), {}, /guard file/);
  });

  it('with Edit, MultiEdit and NotebookEdit too', async () => {
    await expectDenied({ ...write(''), tool_name: 'Edit', tool_input: { file_path: 'factory.json', old_string: 'a', new_string: 'b' } });
    await expectDenied({ ...write(''), tool_name: 'MultiEdit', tool_input: { file_path: 'factory.json', edits: [] } });
    await expectDenied({ ...write(''), tool_name: 'NotebookEdit', tool_input: { notebook_path: 'tests/acceptance/P1/check.ipynb', new_source: '' } });
  });

  it('whatever the role name, unless it is QA', async () => {
    await expectDenied(write('factory.json'), { BB_ROLE: undefined });
    await expectDenied(write('factory.json'), { BB_ROLE: 'poarta' });
  });
});

describe('the guard lets a worker write', () => {
  it('everywhere else in its worktree', async () => {
    await expectSilent(write('src/app.ts'));
    await expectSilent(write(join(wt, 'src', 'app.ts')));
    await expectSilent(write('PROGRESS.md'));
    await expectSilent(write('factory.json.bak'));
    await expectSilent(write('tests/acceptance-notes.md'));
    await expectSilent(write('tests/unit/app.test.ts'));
    await expectSilent(write('db/sub/001.sql')); // `*` is one segment
    await expectSilent(write('.factory/notes.md'));
  });

  it('outside its worktree', async () => {
    await expectSilent(write(join(elsewhere, 'factory.json')));
    await expectSilent(write('../../elsewhere/tests/acceptance/P1/a.ts'));
  });
});

describe('path forms', () => {
  it('resolves .. and a sub-folder as the working directory', async () => {
    await expectDenied(write('src/../factory.json'));
    await expectDenied(write('tests/acceptance/P1/../../../factory.json'), {}, /line file/);
    await expectDenied(write('tests/acceptance/P1/../P2/a.ts'), {}, /another package/);
    await expectSilent(write('tests/acceptance/../unit/a.ts'));
    await expectDenied(write('../factory.json', join(wt, 'src')));
    await expectDenied(write('../tests/acceptance/P1/a.ts', join(wt, 'src')));
    await expectSilent(write('./app.ts', join(wt, 'src')));
    await expectDenied(write('./././factory.json'));
    await expectDenied(write('src//..//factory.json'));
  });

  it('finds the worktree from an absolute path when the session runs elsewhere', async () => {
    await expectDenied(write(join(wt, 'factory.json'), elsewhere));
    await expectSilent(write(join(wt, 'src', 'a.ts'), elsewhere));
  });

  it.runIf(WIN)('takes the Windows forms: backslashes, forward slashes, any case, Git Bash and \\\\?\\', async () => {
    const fwd = wt.replace(/\\/g, '/');
    await expectDenied(write(`${wt}\\factory.json`));
    await expectDenied(write(`${fwd}/factory.json`));
    await expectDenied(write(`${wt.toUpperCase()}\\FACTORY.JSON`));
    await expectDenied(write('tests\\acceptance\\P1\\a.spec.ts'));
    await expectDenied(write('Tests\\Acceptance\\p1\\a.spec.ts'));
    await expectDenied(write(`/${fwd[0].toLowerCase()}${fwd.slice(2)}/factory.json`));
    await expectDenied(write(`\\\\?\\${wt}\\factory.json`));
    await expectDenied(write('tests\\acceptance\\P1\\..\\..\\..\\factory.json'));
    await expectSilent(write(`${wt}\\src\\app.ts`));
  });

  it.runIf(!FOLDS)('is case-sensitive where the file system is', async () => {
    await expectSilent(write('FACTORY.JSON'));
    await expectDenied(write(`${wt}/factory.json`));
  });

  it('follows a link that points into a protected folder', async () => {
    const link = join(wt, 'shortcut');
    try {
      symlinkSync(join(wt, 'tests', 'acceptance'), link, 'junction');
    } catch {
      return; // no permission to create links here
    }
    await expectDenied(write('shortcut/P1/a.spec.ts'), {}, /acceptance tests/);
    await expectDenied(write(join(link, 'P2', 'b.spec.ts')), {}, /another package/);
  });
});

describe('QA', () => {
  const qa = { BB_ROLE: 'qa' };
  it('may write inside its acceptance folder', async () => {
    await expectSilent(write('tests/acceptance/P1/login.spec.ts'), qa);
    await expectSilent(write(join(wt, 'tests', 'acceptance', 'P1', 'CONTRACT.md')), qa);
    await expectSilent(write('tests/acceptance/P1/sub/deep.spec.ts'), qa);
  });

  it('may write nowhere else', async () => {
    await expectDenied(write('src/app.ts'), qa, /QA for P1 writes only inside its acceptance folder tests\/acceptance\/P1\//);
    await expectDenied(write('tests/acceptance/P2/x.spec.ts'), qa);
    await expectDenied(write('tests/acceptance/P1/../P2/x.spec.ts'), qa);
    await expectDenied(write('factory.json'), qa);
    await expectDenied(write(join(elsewhere, 'notes.md')), qa);
    await expectDenied(write('tests/acceptance/P10/x.spec.ts'), qa);
  });
});

describe('the guard fails open', () => {
  it('without BB_TASK', async () => {
    await expectSilent(write('factory.json'), { BB_TASK: undefined });
    await expectSilent(write('factory.json'), { BB_TASK: '' });
  });

  it('without a guard file', async () => {
    await expectSilent(write(join(elsewhere, 'factory.json'), elsewhere));
    await expectSilent(write('factory.json', elsewhere));
  });

  it('on input it cannot read', async () => {
    for (const bad of ['', 'not json', '[]', 'null', '{"tool_name":"Write"}', '{"tool_name":"Write","tool_input":{"file_path":42}}']) await expectSilent(bad);
  });

  it('for other tools and empty paths', async () => {
    await expectSilent({ ...write(''), tool_name: 'Bash', tool_input: { command: 'echo > factory.json' } });
    await expectSilent({ ...write(''), tool_name: 'Read', tool_input: { file_path: 'factory.json' } });
    await expectSilent(write('   '));
  });

  it('when the guard file is broken', async () => {
    const dir = join(base, 'broken');
    mkdirSync(join(dir, '.factory'), { recursive: true });
    writeFileSync(join(dir, '.factory', 'guard.json'), '{ not json');
    await expectSilent(write('factory.json', dir));
    writeFileSync(join(dir, '.factory', 'guard.json'), JSON.stringify({ version: 1, protected: 'factory.json' }));
    await expectSilent(write('factory.json', dir));
  });

  it('fast, and without writing to stderr', async () => {
    const r = await runGuard(write('factory.json'));
    expect(r.decision?.permissionDecision).toBe('deny');
    expect(r.stderr).toBe('');
    expect(r.ms).toBeLessThan(1500);
  });
});

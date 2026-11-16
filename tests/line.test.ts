// The line file (SPEC §12.3): one schema, its defaults, which gates are on, the §11.7 recipe as a line, readable errors,
// placeholders filled from validated values only, and `bb line check`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptanceRoot, argvStepsOf, enabledGates, fill, fillCommand, isLegacyLine, lineEnv, lineVars, quoteFor, resolveLine, shellKind, stepPlan, validRef, type ResolvedLine,
} from '../shared/line.ts';
import { TASK_VAR_NAMES } from '../shared/factory.ts';
import { lineCli } from '../cli/line.ts';

const ok = (raw: unknown, checkoutDir = 'C:/repos/shop'): ResolvedLine => {
  const r = resolveLine(raw, { checkoutDir });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.line;
};
const errors = (raw: unknown) => {
  const r = resolveLine(raw, { checkoutDir: '/r/co' });
  return r.ok ? [] : r.errors;
};

describe('resolveLine', () => {
  it('fills every default of §12.3', () => {
    const l = ok({ commands: { verify: 'npm test' } });
    expect(l).toMatchObject({
      base: 'main', branch: 'pkg/{id}', worktree: '../shop-wt/{id}', file: 'factory.json', legacy: false, envFile: '.env.factory', env: {},
      paths: { packages: 'factory/packages', acceptance: 'tests/acceptance/{localId}', shots: 'test-results/shots/{localId}', protected: [] },
      app: { readyPath: '/', readyTimeoutSec: 180 },
      gates: { G2: { qa: true }, G3: { security: 'sensitive' }, G4: { chrome: false }, G5: { push: true } },
      models: { worker: 'opus', qa: 'opus', review: 'opus', visual: 'sonnet', foreman: 'opus', planner: 'opus' },
      worker: { launcher: 'hc', permissionMode: 'auto', limitHours: 10, subagents: 4, chrome: false },
      limits: { workers: 2 }, integrate: { approval: 'sensitive' }, context: ['CLAUDE.md'],
    });
    expect(l.shell).toBeUndefined();
    expect(l.resources).toBeUndefined();
    expect(l.limits.rounds).toBeUndefined();
  });

  it('turns G1, G2 and G4 on with their command or argv steps; G3 and G5 always unless enabled: false', () => {
    expect(enabledGates(ok({}))).toEqual(['G3', 'G5']);
    expect(enabledGates(ok({ commands: { verify: 'v', acceptance: 'a', shots: 's' } }))).toEqual(['G1', 'G2', 'G3', 'G4', 'G5']);
    expect(enabledGates(ok({ commands: { verify: 'v' }, gates: { G4: { steps: [{ argv: ['x'] }] } } }))).toEqual(['G1', 'G3', 'G4', 'G5']);
    expect(enabledGates(ok({ commands: { verify: 'v' }, gates: { G1: { enabled: false }, G3: { enabled: false }, G5: { enabled: false } } }))).toEqual([]);
    const qa = ok({ commands: { acceptance: 'a' } });
    expect(qa.qa).toBe(true);
    expect(ok({ commands: { acceptance: 'a' }, gates: { G2: { qa: false } } }).qa).toBe(false);
    expect(ok({ commands: { verify: 'v' } }).qa).toBe(false);
  });

  it('keeps a §11.7 recipe a valid line that runs only its argv steps', () => {
    const recipe = { timeoutSec: 1800, gates: { G1: { timeoutSec: 2400, steps: [{ name: 'G1 verify', argv: ['C:/Program Files/Git/bin/bash.exe', 'g1.sh', '{id}', '{round}'] }] }, G4: { timeoutSec: 0.5, steps: [{ argv: ['x', '{args}'] }] } } };
    expect(isLegacyLine(recipe)).toBe(true);
    const r = resolveLine(recipe, { checkoutDir: 'C:/newme/arond', file: 'fabrica/porti/porti.json' });
    expect(r.ok).toBe(true);
    const l = (r as { line: ResolvedLine }).line;
    expect(l).toMatchObject({ legacy: true, file: 'fabrica/porti/porti.json', timeoutSec: 1800 });
    expect(enabledGates(l)).toEqual(['G1', 'G4']);
    expect(stepPlan(l, 'G1')).toEqual({ kind: 'argv' });
    expect(stepPlan(l, 'G5')).toEqual({ kind: 'off', reason: 'recipe has no G5' });
    expect(stepPlan(l, 'prepare').kind).toBe('off');
    expect(argvStepsOf(l, 'G1')![0].name).toBe('G1 verify');
    // adding "commands" makes it a kit line: the argv steps still win for their gate
    const kit = ok({ ...recipe, commands: { verify: 'npm test' } });
    expect(kit.legacy).toBe(false);
    expect(stepPlan(kit, 'G1')).toEqual({ kind: 'argv' });
    expect(stepPlan(kit, 'G3')).toEqual({ kind: 'builtin' });
    expect(stepPlan(kit, 'prepare')).toEqual({ kind: 'builtin' });
    expect(stepPlan(kit, 'G2')).toEqual({ kind: 'off', reason: 'G2 is off in the line' });
  });

  it('argv steps of a kit step win over the built-in', () => {
    const l = ok({ steps: { cleanup: { steps: [{ argv: ['bash', 'curata.sh', '{id}'] }], timeoutSec: 60 } } });
    expect(stepPlan(l, 'cleanup')).toEqual({ kind: 'argv' });
    expect(stepPlan(l, 'revert')).toEqual({ kind: 'builtin' });
  });

  it('answers readable errors', () => {
    expect(errors([])).toEqual(['the line file must hold a JSON object']);
    expect(errors({ commands: { verfy: 'npm test' } })).toEqual(['commands: Unrecognized key: "verfy"']);
    expect(errors({ cmds: {} })[0]).toMatch(/Unrecognized key: "cmds"/);
    expect(errors({ branch: 'pkg/x' })[0]).toMatch(/^branch: a template with \{id\}/);
    expect(errors({ branch: 'pkg/{id}..x' })[0]).toMatch(/^branch: a branch name once filled/);
    expect(errors({ base: '-main' })[0]).toMatch(/^base: a branch name/);
    expect(errors({ worktree: '../wt/fixed' })[0]).toMatch(/^worktree: a path template with \{id\}/);
    expect(errors({ paths: { acceptance: '../outside/{localId}' } })[0]).toMatch(/^paths.acceptance: a path relative to the repo/);
    expect(errors({ paths: { shots: 'C:/abs/{id}' } })[0]).toMatch(/^paths.shots: a path relative to the repo/);
    expect(errors({ paths: { protected: ['ok', 'x/{nope}'] } })[0]).toMatch(/^paths.protected.1: only the placeholders/);
    expect(errors({ env: { 'BAD-NAME': 'x' } })[0]).toMatch(/^env\.BAD-NAME: Invalid key/);
    expect(errors({ commands: { verify: 'a\nb' } })[0]).toMatch(/^commands.verify: one line/);
    expect(errors({ resources: { ports: [5000, 4000] } })[0]).toMatch(/from <= to/);
    expect(errors({ gates: { G3: { security: 'sometimes' } } })[0]).toMatch(/^gates.G3.security/);
    expect(errors({ gates: { G1: { enabled: true } } })).toEqual(['gates.G1: enabled, but there is no commands.verify and no steps']);
    expect(errors({ models: { review: '--dangerous' } })[0]).toMatch(/^models.review: a model name/);
    expect(errors({ gates: { G1: { steps: [] } } })[0]).toMatch(/^gates.G1.steps/);
    // comments are allowed
    expect(errors({ $schema: 'x', '// note': 'y', commands: { verify: 'v' } })).toEqual([]);
  });

  it('accepts a full line', () => {
    const l = ok({
      base: 'develop', branch: 'feature/{idLower}', worktree: 'D:/wt/{project}/{id}', shell: ['C:/Program Files/Git/bin/bash.exe', '-c'],
      commands: { setup: 'pnpm i', verify: 'pnpm verify', acceptance: 'pnpm acc {localId}', shots: 'pnpm shots {localId}', app: 'pnpm dev --port {port}', cleanup: 'dropdb {db}' },
      app: { url: 'http://localhost:{port}', readyPath: '/login', readyTimeoutSec: 90 },
      paths: { packages: 'docs/packages', acceptance: 'e2e/acc/{localId}', shots: 'shots/{localId}', protected: ['migrations/', '*.lock'] },
      env: { PORT: '{port}', DATABASE_URL: 'postgres://localhost/{db}' }, envFile: '.env.local',
      resources: { ports: [5600, 5609], dbPrefix: 'shop_', migrations: { from: 40 } },
      gates: { G3: { security: 'always' }, G4: { chrome: true, timeoutSec: 3600 }, G5: { push: false } },
      models: { foreman: null, visual: 'sonnet' }, worker: { launcher: 'claude', permissionMode: 'acceptEdits' }, limits: { workers: 3, rounds: 5 },
      integrate: { approval: 'always' }, context: ['CLAUDE.md', 'docs/arch.md'],
    });
    expect(l.resources).toEqual({ ports: [5600, 5609], dbPrefix: 'shop_', migrations: { from: 40, block: 10 } });
    expect(l.models.foreman).toBeNull();
    expect(acceptanceRoot(l)).toBe('e2e/acc/');
  });
});

describe('placeholders', () => {
  const line = ok({ commands: { verify: 'v' } });

  it('fills all the names of §12.2 from validated values', () => {
    const v = lineVars(line, { id: 'ED-P1', localId: 'P1', project: 'shop', round: 2, port: 4100, db: 'shop_ed_p1' }, 'C:/wt/ED-P1');
    expect(Object.keys(v).sort()).toEqual([...TASK_VAR_NAMES].sort());
    expect(v).toEqual({ id: 'ED-P1', idLower: 'ed-p1', localId: 'P1', localIdLower: 'p1', project: 'shop', round: '2', port: '4100', db: 'shop_ed_p1', worktree: 'C:/wt/ED-P1', branch: 'pkg/ED-P1' });
    expect(fill('{id} {idLower} {localId} {localIdLower} {project} {round} {port} {db} {worktree} {branch} {other} {ID}', v)).toBe('ED-P1 ed-p1 P1 p1 shop 2 4100 shop_ed_p1 C:/wt/ED-P1 pkg/ED-P1 {other} {ID}');
    expect(lineEnv(ok({ env: { PORT: '{port}', URL: 'http://x/{db}' } }), v)).toEqual({ PORT: '4100', URL: 'http://x/shop_ed_p1' });
  });

  it('refuses values that are not ids, numbers or names', () => {
    expect(() => lineVars(line, { id: 'P1; rm -rf /' }, '')).toThrow(/invalid package id/);
    expect(() => lineVars(line, { id: 'P1', localId: 'a b' }, '')).toThrow(/invalid local id/);
    expect(() => lineVars(line, { id: 'P1', project: 'Shop!' }, '')).toThrow(/invalid project key/);
    expect(() => lineVars(line, { id: 'P1', port: '80; x' }, '')).toThrow(/invalid port/);
    expect(() => lineVars(line, { id: 'P1', port: 70000 }, '')).toThrow(/invalid port/);
    expect(() => lineVars(line, { id: 'P1', db: 'x" & y' }, '')).toThrow(/invalid database name/);
    expect(() => lineVars(line, { id: 'P1', round: '1 2' }, '')).toThrow(/invalid round/);
    expect(() => lineVars(line, { id: 'a..b' }, '')).toThrow(/invalid branch/);
  });

  it('quotes a value that is not plain for the line\'s shell', () => {
    const v = lineVars(line, { id: 'P1' }, "C:/my wt/it's/P1");
    expect(shellKind(undefined, 'win32')).toBe('cmd');
    expect(shellKind(undefined, 'linux')).toBe('posix');
    expect(shellKind(['C:/Program Files/Git/bin/bash.exe', '-c'], 'win32')).toBe('posix');
    expect(shellKind(['pwsh', '-Command'], 'win32')).toBe('powershell');
    expect(fillCommand(line, 'run {id} in {worktree}', v, 'win32')).toBe(`run P1 in "C:/my wt/it's/P1"`);
    expect(fillCommand({ shell: ['bash', '-c'] }, 'cd {worktree}', v, 'win32')).toBe(`cd 'C:/my wt/it'\\''s/P1'`);
    expect(fillCommand({ shell: ['powershell', '-Command'] }, 'cd {worktree}', v, 'win32')).toBe(`cd 'C:/my wt/it''s/P1'`);
    expect(quoteFor('posix')('C:/plain/path-1.2')).toBe('C:/plain/path-1.2');
    expect(quoteFor('posix')('')).toBe("''");
  });

  it('validRef', () => {
    for (const r of ['main', 'pkg/P1', 'release/1.2', 'bb-acceptance/ED-P1']) expect(validRef(r)).toBe(true);
    for (const r of ['-x', '/x', 'a..b', 'a//b', 'x.lock', 'x/', 'x.', 'a b', 'a@{1}']) expect(validRef(r)).toBe(false);
  });
});

describe('bb line check', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bb-line-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const cli = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await lineCli(args, (s) => out.push(s), (s) => err.push(s));
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('prints the resolved line: enabled gates, commands, worktree and branch for a sample id', async () => {
    writeFileSync(join(dir, 'factory.json'), JSON.stringify({ commands: { verify: 'npm test', acceptance: 'npm run acc -- {localId}' }, branch: 'feat/{idLower}' }));
    const r = await cli(['check', dir, '--id', 'ED-P7']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('enabled gates: G1 G2 G3 G5 · QA before the build');
    expect(r.out).toContain('G1: commands.verify: npm test');
    expect(r.out).toContain('G2: commands.acceptance: npm run acc -- ED-P7, after QA');
    expect(r.out).toContain('G4: off');
    expect(r.out).toMatch(/for package ED-P7: branch feat\/ed-p7 · worktree .*-wt[\\/]ED-P7/);
    const json = await cli(['check', dir, '--json']);
    expect(JSON.parse(json.out)).toMatchObject({ legacy: false, enabled: { G1: true, G4: false } });
  });

  it('prints the errors and exits 1', async () => {
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ commands: { verfy: 'x' }, base: '..' }));
    const r = await cli(['check', dir, '--file', 'bad.json']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/2 errors/);
    expect(r.err).toContain('commands: Unrecognized key: "verfy"');
    writeFileSync(join(dir, 'broken.json'), '{ nope');
    expect((await cli(['check', dir, '--file', 'broken.json'])).err).toMatch(/not valid JSON/);
    expect((await cli(['check', join(dir, 'missing')])).code).toBe(1);
    expect((await cli(['nope'])).code).toBe(1);
  });
});

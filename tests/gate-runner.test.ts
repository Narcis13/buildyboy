// Gate runner: recipe steps run as argv (no shell) from the trusted checkout, results reported over HTTP.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateCommand, GateReport } from '../shared/factory.ts';
import { HttpError } from '../runner/api.ts';
import { expandArgv, runGate, type GateDeps } from '../runner/gate.ts';

type Run = GateCommand['run'];

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const STEP = `
import { writeFileSync } from 'node:fs';
const [id, mode, ...rest] = process.argv.slice(2);
const env = { task: process.env.BB_TASK, role: process.env.BB_ROLE, gate: process.env.BB_GATE, round: process.env.BB_ROUND, port: process.env.BB_PORT, db: process.env.BB_DB, worktree: process.env.BB_WORKTREE };
console.log('output of ' + mode + ' for ' + id);
console.error('stderr of ' + mode);
if (mode === 'ok') {
  console.log(JSON.stringify({
    verdict: 'pass', summary: 'ok ' + id,
    details: { env, argv: process.argv.slice(2), rest },
    findings: [
      { severity: 'major', title: ' Bad thing ', file: 'a.ts', line: '12.7', detail: 'd', fix: 'f' },
      { severity: 'fatal', title: 'wrong severity' },
      { severity: 'minor', title: '   ' },
      'nonsense',
    ],
    shots: ['shot.png', 'missing.png', { name: 'named', path: 'shot.png' }, { path: 'notes.txt' }],
  }));
} else if (mode === 'plain') {
  console.log('just a line, not json');
} else if (mode === 'fail') {
  console.log(JSON.stringify({ verdict: 'fail', summary: 'it broke', findings: [{ severity: 'blocker', title: 'broken' }] }));
  process.exit(1);
} else if (mode === 'marker') {
  writeFileSync(rest[0], 'ran');
} else if (mode === 'err') {
  console.log('crashing');
  process.exit(2);
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'skip') {
  console.log(JSON.stringify({ verdict: 'skip', summary: 'skipped ' + rest[0], details: { why: rest[0] } }));
}
`;

let tmp: string;
let root: string;
let checkout: string;
let other: string;
let marker: string;

const node = (...a: string[]) => [process.execPath, '{recipeDir}/step.mjs', '{id}', ...a];

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bb-gate-')));
  root = join(tmp, 'root');
  checkout = join(root, 'co');
  other = join(tmp, 'other');
  mkdirSync(checkout, { recursive: true });
  mkdirSync(join(other, 'co'), { recursive: true });
  marker = join(checkout, 'marker.txt');
  writeFileSync(join(checkout, 'step.mjs'), STEP);
  writeFileSync(join(checkout, 'shot.png'), PNG);
  writeFileSync(join(checkout, 'notes.txt'), 'not an image');
  writeFileSync(
    join(checkout, 'recipe.json'),
    JSON.stringify({
      timeoutSec: 60,
      gates: {
        G1: { steps: [{ name: 'main', argv: node('ok', '{args}', 'x-{args}-y') }, { name: 'second', argv: node('plain') }] },
        G2: { steps: [{ name: 'breaks', argv: node('fail') }, { name: 'after', argv: node('marker', marker) }] },
        G3: { steps: [{ name: 'crasher', argv: node('err') }] },
        G4: { timeoutSec: 0.5, steps: [{ name: 'slow', argv: node('hang') }] },
        G5: { steps: [{ argv: node('skip', 'one') }, { name: 'two', argv: node('skip', 'two') }] },
      },
    }),
  );
  writeFileSync(join(root, 'outside.json'), JSON.stringify({ gates: { G1: { steps: [{ argv: [process.execPath, '-e', '0'] }] } } }));
  writeFileSync(join(other, 'co', 'recipe.json'), JSON.stringify({ gates: { G1: { steps: [{ argv: [process.execPath, '-e', '0'] }] } } }));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fake() {
  const posts: { path: string; body: GateReport }[] = [];
  const logs: string[] = [];
  const deps: GateDeps = {
    allowedRoots: [root],
    api: {
      async post(path: string, body: unknown) {
        posts.push({ path, body: body as GateReport });
        return null;
      },
    },
    log: (s) => logs.push(s),
  };
  return { posts, logs, deps };
}

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run-1',
  taskId: 'task-9',
  gate: 'G1',
  round: 2,
  args: [],
  checkout,
  recipe: 'recipe.json',
  vars: { id: 'P-12', idLower: 'p-12', worktree: 'C:/wt/p-12', round: '2', port: '4312', db: 'p_12' },
  ...over,
});

describe('expandArgv', () => {
  const vars = { id: 'P-1', idLower: 'p-1', worktree: '/wt', round: '3', port: '99', db: 'dbx' };
  it('replaces placeholders and leaves unknown ones', () => {
    expect(expandArgv(['{id}', 'a-{idLower}-{round}', '{worktree}/x', '{recipeDir}/s.sh', '{port}:{db}', '{nope}', '{ID}'], vars, [], '/r')).toEqual(['P-1', 'a-p-1-3', '/wt/x', '/r/s.sh', '99:dbx', '{nope}', '{ID}']);
  });
  it('expands an element that is exactly {args} into zero or more elements', () => {
    expect(expandArgv(['run', '{args}', 'end'], vars, ['a b', 'c'], '/r')).toEqual(['run', 'a b', 'c', 'end']);
    expect(expandArgv(['run', '{args}', 'end'], vars, [], '/r')).toEqual(['run', 'end']);
  });
  it('joins args with a space inside a longer element', () => {
    expect(expandArgv(['--args={args}', 'x {args}'], vars, ['a', 'b'], '/r')).toEqual(['--args=a b', 'x a b']);
  });
});

describe('runGate', () => {
  it('passes with findings and a shot, expands placeholders, tags the env, and keeps the log', async () => {
    const { posts, deps } = fake();
    const r = await runGate(run({ args: ['one', 'two'] }), deps);
    expect(r.status).toBe('done');
    expect(r.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.summary).toBe('ok P-12');
    const d = r.details as { env: Record<string, string>; argv: string[]; rest: string[] };
    expect(d.env).toEqual({ task: 'task-9', role: 'poarta', gate: 'G1', round: '2', port: '4312', db: 'p_12', worktree: 'C:/wt/p-12' });
    expect(d.argv).toEqual(['P-12', 'ok', 'one', 'two', 'x-one two-y']);
    expect(r.findings).toEqual([{ severity: 'major', title: 'Bad thing', file: 'a.ts', line: 12, detail: 'd', fix: 'f' }]);
    expect(r.shots?.map((s) => s.name)).toEqual(['shot', 'named']);
    expect(Buffer.from(r.shots![0].base64, 'base64').equals(PNG)).toBe(true);
    expect(r.shots![0].mime).toBe('image/png');
    expect(r.log).toContain('output of ok for P-12');
    expect(r.log).toContain('stderr of ok');
    expect(r.log).toContain('output of plain for P-12');
    expect(r.log).toMatch(/^\$ .*step\.mjs P-12 ok one two x-one two-y$/m);
    expect(posts[0].path).toBe('/api/runner/gates/run-1');
    expect(posts.at(-1)!.body).toEqual(r);
  });

  it('posts running first and exactly one final report', async () => {
    const { posts, deps } = fake();
    await runGate(run(), deps);
    expect(posts.map((p) => p.body.status)).toEqual(['running', 'done']);
    expect(posts[0].body).toEqual({ status: 'running' });
  });

  it('a failing step (exit 1) stops the gate before the next step', async () => {
    const { deps } = fake();
    const r = await runGate(run({ gate: 'G2' }), deps);
    expect(r.status).toBe('done');
    expect(r.verdict).toBe('fail');
    expect(r.exitCode).toBe(1);
    expect(r.summary).toBe('it broke');
    expect(r.findings).toEqual([{ severity: 'blocker', title: 'broken' }]);
    expect(existsSync(marker)).toBe(false);
    expect(r.log).not.toContain('output of marker');
  });

  it('exit 2 is an error, with the step name and the log', async () => {
    const { posts, deps } = fake();
    const r = await runGate(run({ gate: 'G3' }), deps);
    expect(r.status).toBe('error');
    expect(r.error).toBe('step crasher exited with code 2');
    expect(r.exitCode).toBe(2);
    expect(r.log).toContain('crashing');
    expect(posts.map((p) => p.body.status)).toEqual(['running', 'error']);
  });

  it('a step over its timeout is killed and reported as an error', async () => {
    const { deps } = fake();
    const t = Date.now();
    const r = await runGate(run({ gate: 'G4' }), deps);
    expect(r.status).toBe('error');
    expect(r.error).toBe('step slow timed out after 0.5s');
    expect(Date.now() - t).toBeLessThan(15_000);
  });

  it('every step skipping makes the gate skip, with the summaries joined and the details per step', async () => {
    const { deps } = fake();
    const r = await runGate(run({ gate: 'G5' }), deps);
    expect(r.status).toBe('done');
    expect(r.verdict).toBe('skip');
    expect(r.summary).toBe('skipped one · skipped two');
    expect(r.details).toEqual({ steps: [{ name: 'step 1', details: { why: 'one' } }, { name: 'two', details: { why: 'two' } }] });
  });

  it('refuses a recipe path that escapes the checkout', async () => {
    const { posts, deps } = fake();
    const r = await runGate(run({ recipe: '../outside.json' }), deps);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/outside the checkout/);
    expect(posts.map((p) => p.body.status)).toEqual(['running', 'error']);
    const abs = await runGate(run({ recipe: join(root, 'outside.json') }), fake().deps);
    expect(abs.error).toMatch(/outside the checkout/);
  });

  it('refuses a checkout outside the allowed roots', async () => {
    const { deps } = fake();
    const r = await runGate(run({ checkout: join(other, 'co') }), deps);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/outside the runner's allowed roots/);
  });

  it('reports a gate the recipe does not have, and an unreadable recipe', async () => {
    const { deps } = fake();
    writeFileSync(join(checkout, 'small.json'), JSON.stringify({ gates: { G1: { steps: [{ argv: [process.execPath, '-e', '0'] }] } } }));
    expect((await runGate(run({ gate: 'G3', recipe: 'small.json' }), deps)).error).toBe('recipe has no G3');
    expect((await runGate(run({ recipe: 'nope.json' }), deps)).error).toMatch(/cannot read recipe/);
  });

  it.runIf(process.platform === 'win32')('refuses .cmd and .bat without enabling a shell', async () => {
    const { deps } = fake();
    writeFileSync(join(checkout, 'bat.json'), JSON.stringify({ gates: { G1: { steps: [{ argv: ['C:\\tools\\x.cmd', '{id}'] }] } } }));
    const r = await runGate(run({ recipe: 'bat.json' }), deps);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/cmd\.exe/);
  });

  it('a spawn failure is an error', async () => {
    const { deps } = fake();
    writeFileSync(join(checkout, 'nospawn.json'), JSON.stringify({ gates: { G1: { steps: [{ name: 'ghost', argv: [join(tmp, 'does-not-exist-bin')] }] } } }));
    const r = await runGate(run({ recipe: 'nospawn.json' }), deps);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/step ghost could not start/);
  });

  it('retries the final report on a 5xx and gives up on a 4xx', async () => {
    const retry = { initialMs: 10, maxMs: 20, totalMs: 5000 };
    const calls: string[] = [];
    let fails = 2;
    const flaky: GateDeps = {
      ...fake().deps,
      retry,
      api: {
        async post(_p: string, body: unknown) {
          const b = body as GateReport;
          calls.push(b.status);
          if (b.status !== 'running' && fails-- > 0) throw new HttpError(503, 'down');
          return null;
        },
      },
    };
    await runGate(run(), flaky);
    expect(calls).toEqual(['running', 'done', 'done', 'done']);

    const calls2: string[] = [];
    const rejecting: GateDeps = {
      ...fake().deps,
      retry,
      api: {
        async post(_p: string, body: unknown) {
          calls2.push((body as GateReport).status);
          if ((body as GateReport).status !== 'running') throw new HttpError(404, 'unknown run');
          return null;
        },
      },
    };
    await runGate(run(), rejecting);
    expect(calls2).toEqual(['running', 'done']);
  });

  it('aborting kills the running step and reports an error', async () => {
    const { posts, deps } = fake();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 700);
    writeFileSync(join(checkout, 'hang.json'), JSON.stringify({ gates: { G1: { steps: [{ name: 'hang', argv: node('hang') }] } } }));
    const r = await runGate(run({ recipe: 'hang.json' }), { ...deps, signal: ac.signal });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/runner stopped/);
    expect(posts[0].body.status).toBe('running');
  });
});

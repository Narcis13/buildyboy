import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultValues, leftoverPlaceholders, lintPrompt, listItems, looksRunnable, nameKey, parseSpecRef, parseTemplate, renderTemplate, specRef, type Values,
} from '../shared/harness.ts';

const file = readFileSync(join(import.meta.dirname, '..', 'harness-prompt.md'), 'utf8');
const lf = file.replace(/\r\n/g, '\n');
const crlf = lf.replace(/\n/g, '\r\n');

const FILLED: Values = {
  Goal: 'Add rate limiting to the login endpoint',
  'Done when': '`npm test` passes and `/health` returns 200',
  Scope: 'server/ and tests/',
  Limit: '4 hours',
  Subagents: '3',
  Branch: 'new',
  [nameKey('Branch')]: 'feat/rate-limit',
  PR: 'yes',
  Unattended: 'yes',
};
const EXPECTED: Record<string, string> = {
  Goal: 'Add rate limiting to the login endpoint',
  'Done when': '`npm test` passes and `/health` returns 200',
  Scope: 'server/ and tests/',
  Limit: '4 hours',
  Subagents: '3',
  Branch: 'new, `feat/rate-limit`',
  PR: 'yes',
  Unattended: 'yes',
};

/** The template with each `Key: <hint>` line replaced by hand, as the golden reference. */
function expectedFrom(body: string, vals: Record<string, string>): string {
  return body.replace(/^([A-Za-z ]+:) <.*>(\r?)$/gm, (line, head: string, cr: string) => {
    const key = head.slice(0, -1);
    return key in vals ? `${head} ${vals[key]}${cr}` : line;
  });
}

describe.each([
  ['as on disk', file],
  ['LF', lf],
  ['CRLF', crlf],
])('golden: harness-prompt.md (%s)', (_name, body) => {
  const p = parseTemplate(body);

  it('keeps the body verbatim and detects the line ending', () => {
    expect(p.body).toBe(body);
    expect(p.mode).toBe('harness');
    expect(p.eol).toBe(body.includes('\r\n') ? '\r\n' : '\n');
  });

  it('finds the 8 slots with inferred controls', () => {
    expect(p.slots.map((s) => [s.key, s.kind])).toEqual([
      ['Goal', 'textarea'], ['Done when', 'list'], ['Scope', 'textarea'], ['Limit', 'textarea'],
      ['Subagents', 'number'], ['Branch', 'choice'], ['PR', 'toggle'], ['Unattended', 'toggle'],
    ]);
  });

  it('filling every slot changes only the slot values', () => {
    const out = renderTemplate(p, FILLED);
    expect(out).toBe(expectedFrom(body, EXPECTED));
    expect(out).not.toMatch(/^[A-Za-z ]+: <.*>$/m);
    // line endings preserved: no stray bare LF in a CRLF file and no CR in an LF file
    if (p.eol === '\r\n') expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    else expect(out).not.toContain('\r');
  });

  it('leaves everything after the slot block byte-identical', () => {
    const tail = body.slice(body.indexOf(p.eol + p.eol + 'If a missing detail'));
    expect(renderTemplate(p, FILLED).endsWith(tail)).toBe(true);
  });

  it('drops the hint and leaves "Key:" when a value is empty', () => {
    const out = renderTemplate(p, {});
    expect(out).toContain('Goal:' + p.eol);
    expect(out).not.toContain('<what you want');
    expect(out.length).toBeLessThan(body.length);
  });

  it('appends extra markdown as a Spec section using the file line ending', () => {
    const out = renderTemplate(p, FILLED, 'line one\n\nline two');
    expect(out.startsWith(renderTemplate(p, FILLED))).toBe(true);
    expect(out.endsWith(`${p.eol}## Spec${p.eol}${p.eol}line one${p.eol}${p.eol}line two${p.eol}`)).toBe(true);
    expect(renderTemplate(p, FILLED, '  \n')).toBe(renderTemplate(p, FILLED));
  });
});

describe('round trip', () => {
  const p = parseTemplate(file);
  it('survives JSON serialization (server to web and back)', () => {
    const copy = JSON.parse(JSON.stringify(p));
    expect(renderTemplate(copy, FILLED, 'x')).toBe(renderTemplate(p, FILLED, 'x'));
  });
  it('re-parsing the same body gives the same slots and spans', () => {
    expect(parseTemplate(p.body)).toEqual(p);
  });
  it('rendering is stable for default values', () => {
    const v = defaultValues(p);
    expect(renderTemplate(p, v)).toBe(renderTemplate(parseTemplate(file), { ...v }));
    expect(v).toMatchObject({ Subagents: '5', Branch: 'new', PR: 'no', Unattended: 'no' });
  });
  it('spec file reference round-trips', () => {
    expect(parseSpecRef(specRef('docs/spec.md'))).toBe('docs/spec.md');
    expect(parseSpecRef('# some other spec')).toBeNull();
  });
});

describe('Done when rendering', () => {
  const p = parseTemplate(lf);
  it('renders one check inline', () => {
    expect(renderTemplate(p, { 'Done when': '`npm test` passes' })).toContain('\nDone when: `npm test` passes\n');
  });
  it('renders several checks as a numbered list, stripping list markers and blanks', () => {
    const out = renderTemplate(p, { 'Done when': '- `npm test` passes\n\n2) `/health` returns 200\n  * lint is clean' });
    expect(out).toContain('\nDone when:\n  1. `npm test` passes\n  2. `/health` returns 200\n  3. lint is clean\nScope:');
    expect(listItems('- a\n\n b ')).toEqual(['a', 'b']);
  });
  it('indents continuation lines of multi-line text values', () => {
    expect(renderTemplate(p, { Goal: 'first\nsecond' })).toContain('\nGoal: first\n  second\nDone when:');
  });
  it('preview mode turns the slot lines into a markdown list', () => {
    const out = renderTemplate(p, { ...FILLED, 'Done when': 'a b\nc d' }, undefined, { preview: true });
    expect(out).toContain('- **Goal:** Add rate limiting');
    expect(out).toContain('- **Done when:**\n  1. a b\n  2. c d\n- **Scope:** server/');
    expect(out).toContain('- **Unattended:** yes\n\nIf a missing detail');
  });
});

describe('control inference', () => {
  const t = (line: string) => parseTemplate(`# Task\n\n${line}\n\nrest\n`).slots[0];
  it('yes | no is a toggle', () => expect(t('PR: <yes | no — yes needs a new branch>')).toMatchObject({ kind: 'toggle', choices: ['yes', 'no'], help: 'yes needs a new branch' }));
  it('new, e.g. x | current is a choice with a name field', () =>
    expect(t('Branch: <new, e.g. `feat/x` | current>')).toMatchObject({ kind: 'choice', choices: ['new', 'current'], nameFor: 'new', nameExample: 'feat/x' }));
  it('a number with a default is a number field', () => {
    expect(t('Subagents: <max — default 5; 0 to work alone>')).toMatchObject({ kind: 'number', default: '5' });
    expect(t('Retries: <times, default 2>')).toMatchObject({ kind: 'number', default: '2' });
  });
  it('anything else is a textarea', () => {
    expect(t('Scope: <files you may change>').kind).toBe('textarea');
    expect(t('Limit: <e.g. 4 hours or 30 iterations>').kind).toBe('textarea');
    expect(t('Notes: <a | b is a pipe in prose>').kind).toBe('textarea');
  });
  it('Goal is large, Done when is a list', () => {
    expect(t('Goal: <what>').large).toBe(true);
    expect(t('Done: <checks>').kind).toBe('list');
  });
  it('the slot block ends at the first blank line or non-slot line', () => {
    const p = parseTemplate('# Task\n\nA: <a>\nB: <b>\nnot a slot\nC: <c>\n');
    expect(p.slots.map((s) => s.key)).toEqual(['A', 'B']);
    expect(parseTemplate('# Task\n\nA: <a>\n\nB: <b>\n').slots.map((s) => s.key)).toEqual(['A']);
  });
});

describe('lint', () => {
  const p = parseTemplate(file);
  const ok: Values = { ...FILLED };
  const ids = (v: Values) => lintPrompt(p, v).map((w) => w.id);
  it('has no warnings for a good prompt', () => expect(lintPrompt(p, ok)).toEqual([]));
  it('PR: yes requires a new branch', () => {
    expect(ids({ ...ok, Branch: 'current' })).toEqual(['pr-needs-branch']);
    expect(ids({ ...ok, Branch: 'current', PR: 'no' })).toEqual([]);
  });
  it('Unattended: yes without a Limit', () => {
    expect(ids({ ...ok, Limit: '  ' })).toEqual(['unattended-no-limit']);
    expect(ids({ ...ok, Limit: '', Unattended: 'no' })).toEqual([]);
  });
  it('empty Done when, or no runnable command', () => {
    expect(ids({ ...ok, 'Done when': '\n  \n' })).toEqual(['done-empty']);
    expect(ids({ ...ok, 'Done when': 'it feels right' })).toEqual(['done-no-command']);
    expect(ids({ ...ok, 'Done when': 'the page looks good\npytest -q passes' })).toEqual([]);
    expect(ids({ ...ok, 'Done when': '`/health` returns 200' })).toEqual(['done-no-command']);
    expect(ids({ ...ok, 'Done when': 'make sure it works' })).toEqual(['done-no-command']);
  });
  it('Subagents must be a number', () => {
    expect(ids({ ...ok, Subagents: 'five' })).toEqual(['number-invalid']);
    expect(ids({ ...ok, Subagents: '' })).toEqual(['number-invalid']);
    expect(ids({ ...ok, Subagents: '0' })).toEqual([]);
  });
  it('flags leftover placeholders typed into a value', () => {
    expect(ids({ ...ok, Scope: 'src/<dir>' })).toEqual(['leftover']);
    expect(ids({ ...ok, Scope: 'the `<dir>` folder, <br> tags, <https://x.dev>' })).toEqual([]);
  });
  it('recognizes runnable checks', () => {
    for (const c of ['`npm test` passes', 'curl localhost:3000/health returns 200', 'pytest passes', 'run `bin/check --all`', 'make test is green']) expect(looksRunnable(c), c).toBe(true);
    for (const c of ['looks good', 'go to the page', '`/health`']) expect(looksRunnable(c), c).toBe(false);
  });
});

describe('generic templates with <...> placeholders', () => {
  const body = 'Fix <the bug> in <module>.\r\nAdd a test for <the bug>, see <https://x.dev/a> and <br>.\r\nRun `cmd <arg>` and <!-- note -->.\r\n';
  const p = parseTemplate(body);
  it('turns each distinct placeholder into a textarea slot, skipping HTML and links', () => {
    expect(p.mode).toBe('generic');
    expect(p.eol).toBe('\r\n');
    expect(p.slots.map((s) => [s.key, s.kind])).toEqual([['the bug', 'textarea'], ['module', 'textarea'], ['arg', 'textarea']]);
    expect(p.spans).toHaveLength(4);
  });
  it('replaces every occurrence of a filled placeholder and keeps the rest', () => {
    const out = renderTemplate(p, { 'the bug': 'login crash', module: 'auth' });
    expect(out).toBe('Fix login crash in auth.\r\nAdd a test for login crash, see <https://x.dev/a> and <br>.\r\nRun `cmd <arg>` and <!-- note -->.\r\n');
  });
  it('keeps unfilled placeholders and lints them', () => {
    expect(renderTemplate(p, {})).toBe(body);
    expect(lintPrompt(p, { 'the bug': 'x' }).map((w) => w.id)).toEqual(['unfilled']);
    expect(lintPrompt(p, { 'the bug': 'x', module: 'y', arg: 'z' })).toEqual([]);
  });
  it('a template without any placeholder has no slots', () => {
    const q = parseTemplate('Just text\n');
    expect(q.slots).toEqual([]);
    expect(renderTemplate(q, {}, 'more')).toBe('Just text\n\n## Spec\n\nmore\n');
  });
  it('leftoverPlaceholders ignores code', () => {
    expect(leftoverPlaceholders('a <b c> `<d e>` ```\n<f g>\n```')).toEqual(['<b c>']);
  });
});

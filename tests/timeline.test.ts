import { describe, expect, it } from 'vitest';
import { compactRows, toolSummary, type ToolItem } from '../web/src/components/timeline/summary.ts';
import type { TimelineItem } from '../shared/types.ts';

const cwd = 'C:\\work\\shop-api';
let n = 0;
function tool(name: string, input: Record<string, unknown> | null, over: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: 'tool', id: `t${++n}`, ts: n, tool: name, mcpServer: null, status: 'ok', input, output: null, outputLen: null,
    durationMs: 1000, exitCode: null, filePath: null, command: null, ...over,
  };
}
const out = (v: unknown) => JSON.stringify(v);

describe('toolSummary', () => {
  it('Bash: description, else the command, plus a non-zero exit code', () => {
    expect(toolSummary(tool('Bash', { command: 'npm test', description: 'Run test suite' }, { exitCode: 0 }), cwd)).toBe('Run test suite');
    expect(toolSummary(tool('Bash', { command: 'npm test' }, { command: 'npm test', exitCode: 1 }), cwd)).toBe('npm test · exit 1');
    const long = toolSummary(tool('Bash', { command: `echo ${'x'.repeat(300)}\nls` }), cwd);
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long).not.toContain('\n');
    expect(long.endsWith('…')).toBe(true);
  });

  it('Edit / MultiEdit / Write: relative path and +added −removed', () => {
    const edit = tool('Edit', { file_path: `${cwd}\\src\\routes\\auth.ts`, old_string: 'a', new_string: 'b\nc' });
    expect(toolSummary(edit, cwd)).toBe('src\\routes\\auth.ts +2 −1');
    const multi = tool('MultiEdit', { file_path: `${cwd}\\src\\app.ts`, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd\ne' }] });
    expect(toolSummary(multi, cwd)).toBe('src\\app.ts +3 −2');
    const write = tool('Write', { file_path: `${cwd}\\new.ts`, content: 'one\ntwo\n' });
    expect(toolSummary(write, cwd)).toBe('new.ts +2 −0');
    // the server's patch wins over the input
    const patched = tool('Edit', { file_path: `${cwd}\\x.ts`, old_string: 'a', new_string: 'b' }, { filePath: `${cwd}\\x.ts`, patch: '--- a/x.ts\n+++ b/x.ts\n@@\n-a\n+b\n+c\n+d' });
    expect(toolSummary(patched, cwd)).toBe('x.ts +3 −1');
    expect(toolSummary(tool('Edit', { old_string: 'a', new_string: 'b' }), cwd)).toBe('+1 −1');
    const nb = tool('NotebookEdit', { notebook_path: `${cwd}\\nb.ipynb`, cell_id: 'c3', new_source: 'x', edit_mode: 'insert' });
    expect(toolSummary(nb, cwd)).toBe('nb.ipynb · insert cell c3');
  });

  it('Read / Grep / Glob: path or pattern plus counts', () => {
    expect(toolSummary(tool('Read', { file_path: `${cwd}\\src\\a.ts` }, { output: out({ file: { numLines: 42, totalLines: 42 } }) }), cwd)).toBe('src\\a.ts · 42 lines');
    expect(toolSummary(tool('Read', { file_path: '/elsewhere/deep/dir/b.ts' }, { output: out({ file: { numLines: 10, totalLines: 300 } }) }), cwd)).toBe('…/deep/dir/b.ts · 10 of 300 lines');
    expect(toolSummary(tool('Grep', { pattern: 'router.post', path: `${cwd}\\src` }, { output: out({ numLines: 1, numFiles: 1 }) }), cwd)).toBe('router.post in src · 1 matching line · 1 file');
    expect(toolSummary(tool('Glob', { pattern: 'src/**/*.ts' }, { output: out({ filenames: ['a'], numFiles: 3 }) }), cwd)).toBe('src/**/*.ts · 3 files');
  });

  it('MCP: server › tool and the most telling input field', () => {
    const nav = tool('mcp__claude-in-chrome__navigate', { tabId: 7, url: 'https://example.com/' }, { mcpServer: 'claude-in-chrome' });
    expect(toolSummary(nav, cwd)).toBe('claude-in-chrome › navigate · https://example.com/');
    const click = tool('mcp__claude-in-chrome__computer', { tabId: 7, action: 'left_click', coordinate: [1, 2] });
    expect(toolSummary(click, cwd)).toBe('claude-in-chrome › computer · left_click');
    const issue = tool('mcp__github__get_issue', { owner: 'example', repo: 'shop-api', issue_number: 42 });
    expect(toolSummary(issue, cwd)).toBe('github › get_issue · example');
    expect(toolSummary(tool('mcp__x__ping', {}), cwd)).toBe('x › ping');
  });

  it('Agent, WebFetch, WebSearch, TodoWrite, AskUserQuestion, ExitPlanMode and unknown tools', () => {
    expect(toolSummary(tool('Agent', { description: 'Review the limiter', subagent_type: 'general-purpose' }), cwd)).toBe('Review the limiter');
    expect(toolSummary(tool('Task', { subagent_type: 'Explore' }), cwd)).toBe('Explore');
    expect(toolSummary(tool('WebFetch', { url: 'https://example.com/rate-limit', prompt: 'Summarize' }), cwd)).toBe('https://example.com/rate-limit');
    expect(toolSummary(tool('WebSearch', { query: 'express rate limit' }), cwd)).toBe('express rate limit');
    const todos = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }];
    expect(toolSummary(tool('TodoWrite', { todos }), cwd)).toBe('1/3 done');
    expect(toolSummary(tool('AskUserQuestion', { questions: [{ question: 'Also /register?', options: [] }] }), cwd)).toBe('Also /register?');
    expect(toolSummary(tool('ExitPlanMode', { plan: '## Plan\n\n1. Do it' }), cwd)).toBe('Plan 1. Do it');
    expect(toolSummary(tool('Skill', { skill: 'deploy' }), cwd)).toBe('deploy');
    expect(toolSummary(tool('Mystery', null), cwd)).toBe('');
  });
});

describe('compactRows', () => {
  const text = (id: string): TimelineItem => ({ kind: 'assistant', id, ts: 0, text: 'hi' });
  const ids = (rows: ReturnType<typeof compactRows>) => rows.map((r) => ('group' in r ? `[${r.group.map((t) => t.id).join(',')}]` : r.id));

  it('folds runs of three or more tool calls with no text between them', () => {
    const a = tool('Bash', {}), b = tool('Read', {}), c = tool('Edit', {}), d = tool('Bash', {}), e = tool('Read', {});
    expect(ids(compactRows([text('x'), a, b, c, text('y'), d, e]))).toEqual(['x', `[${a.id},${b.id},${c.id}]`, 'y', d.id, e.id]);
  });

  it('keeps failed, denied, blocked calls and questions/plans out of groups', () => {
    const a = tool('Bash', {}), b = tool('Bash', {}), bad = tool('Bash', {}, { status: 'error' }), c = tool('Read', {});
    const q = tool('AskUserQuestion', {}), p = tool('ExitPlanMode', {}), x = tool('Bash', {}, { status: 'denied' });
    expect(ids(compactRows([a, b, bad, c, q, p, x]))).toEqual([a.id, b.id, bad.id, c.id, q.id, p.id, x.id]);
  });

  it('keeps the group id stable while a live run grows', () => {
    const run = [tool('Bash', {}), tool('Bash', {}), tool('Bash', {})];
    const first = compactRows(run)[0].id;
    expect(compactRows([...run, tool('Read', {})])[0].id).toBe(first);
  });
});

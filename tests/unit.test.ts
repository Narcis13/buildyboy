import { describe, expect, it } from 'vitest';
import { redactText, redactHookEvent, isEnvFile, redactTranscriptLine, compileRules, MASK } from '../shared/redact.ts';
import { nextStatus, isStale } from '../server/ingest/status.ts';
import { parseTranscriptLine } from '../server/ingest/transcript.ts';
import { diffLines, diffStats, unifiedDiff } from '../shared/diff.ts';
import { activityFor, toolOutput } from '../server/ingest/derive.ts';

describe('redaction', () => {
  const cases: [string, string][] = [
    ['key sk-ant-api03-abcdefghijklmnopqrstuvwx end', 'key [REDACTED] end'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok', 'token [REDACTED] ok'],
    ['gho_ABCDEFGHIJKLMNOPQRSTUV1234', '[REDACTED]'],
    ['AKIAABCDEFGHIJKLMNOP', '[REDACTED]'],
    ['Authorization: Bearer abc.def-ghi_jkl', 'Authorization: Bearer [REDACTED]'],
    ['password=hunter22 user=bob', 'password=[REDACTED] user=bob'],
    ['DB_PASSWORD: "s3cr3t!"', 'DB_PASSWORD: [REDACTED]'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt [REDACTED]'],
  ];
  for (const [input, want] of cases) it(`masks: ${input.slice(0, 30)}`, () => expect(redactText(input)).toBe(want));

  it('leaves ordinary text alone', () => {
    expect(redactText('npm test && git commit -m "fix login"')).toBe('npm test && git commit -m "fix login"');
  });

  it('detects .env files', () => {
    expect(isEnvFile('/app/.env')).toBe(true);
    expect(isEnvFile('C:\\app\\.env.local')).toBe(true);
    expect(isEnvFile('/app/.env.example')).toBe(false);
    expect(isEnvFile('/app/env.ts')).toBe(false);
  });

  it('drops the content of a Read on .env', () => {
    const e = redactHookEvent({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/x/.env' }, tool_response: { file: { content: 'FOO=bar' } } });
    expect(JSON.stringify(e.tool_response)).toContain(MASK);
    expect(JSON.stringify(e)).not.toContain('FOO=bar');
  });

  it('drops .env tool_result content in transcript lines', () => {
    const ids = new Set<string>();
    redactTranscriptLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/.env.local' } }] } }), ids);
    const out = redactTranscriptLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET_THING=1' }] }, toolUseResult: { file: { filePath: '/x/.env.local', content: 'SECRET_THING=1' } } }), ids);
    expect(out).not.toContain('SECRET_THING');
  });

  it('masks the secrets the review found missing', () => {
    const cases: [string, string][] = [
      ['stripe sk_live_abcdefghijklmnop', 'stripe [REDACTED]'],
      ['postgres://admin:hunter2@db.local:5432/app', 'postgres://admin:[REDACTED]@db.local:5432/app'],
      ['xoxb-1234567890-abcdefghij', '[REDACTED]'],
      ['npm_abcdefghijklmnopqrstuvwxyz0123456789', '[REDACTED]'],
      ['AIzaSyA1234567890abcdefghijklmnopqrstu', '[REDACTED]'],
      ['mysql -u root --password hunter2 db', 'mysql -u root --password [REDACTED] db'],
      ['STRIPE_KEY=whsec_123 next', 'STRIPE_KEY=[REDACTED] next'],
    ];
    for (const [input, want] of cases) expect(redactText(input), input).toBe(want);
  });

  it('drops .env content even when the Read and its result arrive in different batches', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'other-batch', content: 'DB_URL=postgres://u:p@h/db\nX=1' }] }, toolUseResult: { file: { filePath: '/repo/.env', content: 'DB_URL=postgres://u:p@h/db' } } });
    const out = redactTranscriptLine(line, new Set());
    expect(out).not.toContain('DB_URL');
    expect(out).toContain('.env file content not stored');
  });

  it('never stores what is written to .env files', () => {
    const e = redactHookEvent({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'C:\\app\\.env.local', content: 'TOKEN_X=abc' } });
    expect(JSON.stringify(e)).not.toContain('abc');
    const t = redactTranscriptLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't9', name: 'Edit', input: { file_path: '/a/.env', old_string: 'A=1', new_string: 'A=2' } }] } }), new Set());
    expect(t).not.toContain('A=2');
  });

  it('supports extra rules', () => {
    const rules = compileRules([{ name: 'acme', pattern: 'ACME-\\d{4}', flags: 'g' }]);
    expect(redactText('id ACME-1234', rules)).toBe('id [REDACTED]');
  });
});

describe('status machine', () => {
  it('follows a normal turn', () => {
    let s = nextStatus('idle', 'SessionStart');
    expect(s).toBe('idle');
    s = nextStatus(s, 'UserPromptSubmit');
    expect(s).toBe('working');
    s = nextStatus(s, 'PreToolUse');
    expect(s).toBe('working');
    s = nextStatus(s, 'PermissionRequest');
    expect(s).toBe('waiting');
    s = nextStatus(s, 'PostToolUse');
    expect(s).toBe('working');
    s = nextStatus(s, 'PreCompact');
    expect(s).toBe('compacting');
    s = nextStatus(s, 'PostCompact');
    expect(s).toBe('working');
    s = nextStatus(s, 'Stop');
    expect(s).toBe('idle');
    s = nextStatus(s, 'StopFailure');
    expect(s).toBe('error');
    s = nextStatus(s, 'SessionEnd');
    expect(s).toBe('ended');
    expect(nextStatus(s, 'PostToolUse')).toBe('ended');
    expect(nextStatus(s, 'SessionStart')).toBe('idle');
  });

  it('maps notifications', () => {
    expect(nextStatus('working', 'Notification', { notification_type: 'permission_prompt' })).toBe('waiting');
    expect(nextStatus('idle', 'Notification', { notification_type: 'idle_prompt' })).toBe('idle');
    expect(nextStatus('working', 'Notification', { notification_type: 'auth_success' })).toBe('working');
  });

  it('detects stale sessions', () => {
    const now = Date.now();
    expect(isStale('working', now - 11 * 60_000, now)).toBe(true);
    expect(isStale('working', now - 5 * 60_000, now)).toBe(false);
    expect(isStale('idle', now - 60 * 60_000, now)).toBe(false);
  });
});

describe('transcript parsing', () => {
  it('parses user prompts and tool results', () => {
    const p = parseTranscriptLine(JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } }));
    expect(p.message).toMatchObject({ uuid: 'u1', kind: 'prompt', text: 'hello', role: 'user' });
    const r = parseTranscriptLine(JSON.stringify({ type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }));
    expect(r.message?.kind).toBe('tool_result');
  });

  it('parses assistant text, thinking and usage', () => {
    const p = parseTranscriptLine(JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'msg_1', model: 'claude-x', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 2 } } }));
    expect(p.message).toMatchObject({ kind: 'text', text: 'hi', model: 'claude-x', apiMessageId: 'msg_1' });
    expect(p.message?.usage?.input_tokens).toBe(5);
    const t = parseTranscriptLine(JSON.stringify({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }));
    expect(t.message).toMatchObject({ kind: 'thinking', text: 'hmm' });
  });

  it('extracts session patches', () => {
    expect(parseTranscriptLine(JSON.stringify({ type: 'ai-title', aiTitle: 'Fix login' })).patch?.name).toBe('Fix login');
    expect(parseTranscriptLine(JSON.stringify({ type: 'cost-state', totalCostUSD: 1.5, totalLinesAdded: 3, totalLinesRemoved: 1 })).patch).toMatchObject({ costUsd: 1.5, linesAdded: 3 });
    expect(parseTranscriptLine(JSON.stringify({ type: 'pr-link', prUrl: 'https://github.com/a/b/pull/1' })).patch?.prUrl).toContain('/pull/1');
    expect(parseTranscriptLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 's1' })).patch?.compaction).toBe(true);
  });

  it('keeps unknown lines as raw instead of dropping them', () => {
    const p = parseTranscriptLine(JSON.stringify({ type: 'brand-new-thing', uuid: 'z1', foo: 1 }));
    expect(p.message?.kind).toBe('raw');
    expect(parseTranscriptLine('{not json').message?.kind).toBe('raw');
    expect(parseTranscriptLine(JSON.stringify({ type: 'file-history-snapshot' })).message).toBeUndefined();
  });
});

describe('diff', () => {
  it('computes a minimal line diff', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
    const u = unifiedDiff('a\nb\nc', 'a\nB\nc', 'f.ts');
    expect(u).toContain('-b');
    expect(u).toContain('+B');
    expect(u).toContain('@@ -1,3 +1,3 @@');
  });
});

describe('activity and output', () => {
  it('describes tools', () => {
    expect(activityFor('Bash', { command: 'npm test' }, null)).toBe('Bash: npm test');
    expect(activityFor('Edit', { file_path: '/repo/server/db.ts' }, '/repo')).toBe('Editing server/db.ts');
    expect(activityFor('mcp__github__get_issue', {}, null)).toBe('github: get_issue');
  });
  it('formats Bash output', () => {
    expect(toolOutput('Bash', { stdout: 'ok', stderr: 'warn' })).toEqual({ text: 'ok\n[stderr]\nwarn', exitCode: 0 });
  });
});

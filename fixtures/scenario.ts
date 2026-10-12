// Synthetic fixture scenario (never copied from real sessions): 3 sessions on 2 machines, covering every tool
// renderer, a subagent, a permission request, an AskUserQuestion, a compaction, a failure and a git commit.
import type { GitInfo, HookEnvelope, HookInput } from '../shared/types.ts';

export const MACHINES = {
  A: { name: 'devbox-win', hostname: 'DEVBOX', platform: 'win32', user: 'dev' },
  B: { name: 'wsl-ubuntu', hostname: 'devbox-wsl', platform: 'wsl', user: 'sysadm' },
} as const;
export type MachineKey = keyof typeof MACHINES;

export const S1 = '11111111-1111-4111-8111-111111111111';
export const S2 = '22222222-2222-4222-8222-222222222222';
export const S3 = '33333333-3333-4333-8333-333333333333';
export const SESSION_NAMES = { [S1]: 'Add rate limiting to login', [S2]: 'Refactor billing exports', [S3]: 'Nightly dependency update' } as const;

export interface Step {
  /** ms offset from scenario start */
  at: number;
  machine: MachineKey;
  envelope: HookEnvelope;
}

const CWD1 = 'C:\\work\\shop-api';
const CWD2 = 'C:\\work\\billing';
const CWD3 = '/home/sysadm/apps/notes';
const MIN = 60_000;

interface Ctx {
  steps: Step[];
  transcripts: Map<string, string[]>;
  t0: number;
}

let uuidN = 0;
const uuid = (sid: string) => `${sid.slice(0, 8)}-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;
let toolN = 0;
const toolId = () => `toolu_fx${String(++toolN).padStart(6, '0')}`;

function line(ctx: Ctx, sid: string, at: number, obj: Record<string, unknown>) {
  const list = ctx.transcripts.get(sid) ?? [];
  list.push(JSON.stringify({ sessionId: sid, timestamp: new Date(ctx.t0 + at).toISOString(), entrypoint: sid === S3 ? 'sdk-cli' : 'cli', version: '2.1.296', ...obj }));
  ctx.transcripts.set(sid, list);
}

function userLine(ctx: Ctx, sid: string, at: number, text: string) {
  line(ctx, sid, at, { type: 'user', uuid: uuid(sid), parentUuid: null, isSidechain: false, message: { role: 'user', content: text } });
}

function assistantLine(ctx: Ctx, sid: string, at: number, blocks: unknown[], usage = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 18000, cache_creation_input_tokens: 900 }) {
  line(ctx, sid, at, { type: 'assistant', uuid: uuid(sid), parentUuid: null, isSidechain: false, message: { id: `msg_fx${uuidN}`, model: 'claude-sonnet-5-5', role: 'assistant', content: blocks, usage } });
}

function step(ctx: Ctx, at: number, machine: MachineKey, event: HookInput, extra: Partial<HookEnvelope> = {}) {
  const m = MACHINES[machine];
  const transcriptPath = event.transcript_path as string;
  ctx.steps.push({
    at,
    machine,
    envelope: {
      v: 1,
      hostname: m.hostname,
      platform: m.platform,
      user: m.user,
      pid: 4000 + ctx.steps.length,
      ppid: 4000,
      hookVersion: '0.1.0',
      ts: ctx.t0 + at,
      env: { CLAUDE_CODE_ENTRYPOINT: event.session_id === S3 ? 'sdk-cli' : 'cli', CLAUDE_PROJECT_DIR: String(event.cwd ?? '') },
      event: { transcript_path: transcriptPath, permission_mode: 'default', ...event },
      ...extra,
    },
  });
}

function git(root: string, branch: string, sha: string, extra: Partial<GitInfo> = {}): GitInfo {
  return { root, branch, sha, ahead: 0, behind: 0, dirty: 0, remote: 'https://github.com/example/' + root.split(/[\\/]/).pop() + '.git', worktree: false, ...extra };
}

/** A tool call: PreToolUse + PostToolUse (or failure), with matching transcript tool_use/tool_result lines. */
function tool(
  ctx: Ctx, at: number, machine: MachineKey, sid: string, cwd: string, name: string, input: Record<string, unknown>,
  result: unknown, opts: { fail?: string; dur?: number; agentId?: string; agentType?: string; git?: GitInfo; noPost?: boolean } = {},
) {
  const id = toolId();
  const base = { session_id: sid, cwd, transcript_path: tp(sid), ...(opts.agentId ? { agent_id: opts.agentId, agent_type: opts.agentType ?? 'general-purpose' } : {}) };
  if (!opts.agentId) assistantLine(ctx, sid, at, [{ type: 'tool_use', id, name, input }]);
  step(ctx, at, machine, { ...base, hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id });
  if (opts.noPost) return id;
  const end = at + (opts.dur ?? 1500);
  if (opts.fail) {
    step(ctx, end, machine, { ...base, hook_event_name: 'PostToolUseFailure', tool_name: name, tool_input: input, tool_use_id: id, error: opts.fail, duration_ms: opts.dur ?? 1500 });
  } else {
    step(ctx, end, machine, { ...base, hook_event_name: 'PostToolUse', tool_name: name, tool_input: input, tool_use_id: id, tool_response: result, duration_ms: opts.dur ?? 1500 }, opts.git ? { git: opts.git } : {});
  }
  if (!opts.agentId) line(ctx, sid, end, { type: 'user', uuid: uuid(sid), parentUuid: null, isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: typeof result === 'string' ? result : JSON.stringify(result ?? opts.fail ?? '') }] } });
  return id;
}

const tp = (sid: string) => (sid === S3 ? `/home/sysadm/.claude/projects/-home-sysadm-apps-notes/${sid}.jsonl` : `C:\\Users\\dev\\.claude\\projects\\C--work-${sid === S1 ? 'shop-api' : 'billing'}\\${sid}.jsonl`);

function session1(ctx: Ctx) {
  const sid = S1;
  const c = CWD1;
  const b = { session_id: sid, cwd: c, transcript_path: tp(sid) };
  const g0 = git(c, 'feat/rate-limit', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  step(ctx, 0, 'A', { ...b, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-5-5' }, { git: g0 });
  line(ctx, sid, 1, { type: 'ai-title', aiTitle: SESSION_NAMES[S1] });
  const prompt = 'Add rate limiting to the login endpoint (5 attempts per minute per IP) and cover it with tests.';
  step(ctx, 2_000, 'A', { ...b, hook_event_name: 'UserPromptSubmit', prompt });
  userLine(ctx, sid, 2_000, prompt);
  assistantLine(ctx, sid, 4_000, [{ type: 'thinking', thinking: 'The login route lives in src/routes/auth.ts. I should check for an existing limiter first.' }]);
  assistantLine(ctx, sid, 5_000, [{ type: 'text', text: "I'll look at the auth routes first, then add a small in-memory limiter.\n\n- check existing middleware\n- add `rateLimit()`\n- add tests" }]);
  tool(ctx, 8_000, 'A', sid, c, 'Glob', { pattern: 'src/**/*.ts' }, { filenames: ['src/routes/auth.ts', 'src/app.ts', 'src/middleware/cors.ts'], numFiles: 3 });
  tool(ctx, 12_000, 'A', sid, c, 'Grep', { pattern: 'router.post\\(.login', path: 'src', output_mode: 'content' }, { mode: 'content', numFiles: 1, numLines: 1, content: "src/routes/auth.ts:14:router.post('/login', async (req, res) => {" });
  tool(ctx, 16_000, 'A', sid, c, 'Read', { file_path: `${c}\\src\\routes\\auth.ts` }, { type: 'text', file: { filePath: `${c}\\src\\routes\\auth.ts`, content: "import { Router } from 'express';\n\nexport const router = Router();\n", numLines: 42, startLine: 1, totalLines: 42 } });
  tool(ctx, 20_000, 'A', sid, c, 'TodoWrite', {
    todos: [
      { content: 'Add rateLimit middleware', status: 'in_progress', activeForm: 'Adding rateLimit middleware' },
      { content: 'Wire it into POST /login', status: 'pending', activeForm: 'Wiring it into POST /login' },
      { content: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
    ],
  }, { oldTodos: [], newTodos: [] });
  tool(ctx, 24_000, 'A', sid, c, 'WebSearch', { query: 'express rate limit per ip sliding window' }, { results: [{ title: 'Rate limiting in Express', url: 'https://example.com/rate-limit' }] });
  tool(ctx, 28_000, 'A', sid, c, 'WebFetch', { url: 'https://example.com/rate-limit', prompt: 'Summarize the sliding window approach' }, { code: 200, result: 'Use a map of timestamps per key and drop entries older than the window.' });
  tool(ctx, 34_000, 'A', sid, c, 'Write', { file_path: `${c}\\src\\middleware\\rateLimit.ts`, content: "const hits = new Map<string, number[]>();\n\nexport function rateLimit(max = 5, windowMs = 60_000) {\n  return (req, res, next) => {\n    const now = Date.now();\n    const list = (hits.get(req.ip) ?? []).filter((t) => now - t < windowMs);\n    list.push(now);\n    hits.set(req.ip, list);\n    if (list.length > max) return res.status(429).send('Too many attempts');\n    next();\n  };\n}\n" }, { type: 'create' });
  tool(ctx, 40_000, 'A', sid, c, 'Edit', { file_path: `${c}\\src\\routes\\auth.ts`, old_string: "router.post('/login', async (req, res) => {", new_string: "router.post('/login', rateLimit(5, 60_000), async (req, res) => {", replace_all: false }, { filePath: `${c}\\src\\routes\\auth.ts` });
  tool(ctx, 44_000, 'A', sid, c, 'MultiEdit', { file_path: `${c}\\src\\app.ts`, edits: [{ old_string: "import cors from './middleware/cors';", new_string: "import cors from './middleware/cors';\nimport { rateLimit } from './middleware/rateLimit';" }, { old_string: 'app.use(cors());', new_string: "app.use(cors());\napp.set('trust proxy', 1);" }] }, { filePath: `${c}\\src\\app.ts` });
  tool(ctx, 50_000, 'A', sid, c, 'Bash', { command: 'npm test', description: 'Run test suite' }, null, { fail: 'Exit code 1\nFAIL test/auth.test.ts\n  ✕ returns 429 after 5 attempts (12 ms)\n\nExpected: 429\nReceived: 200', dur: 6200 });
  assistantLine(ctx, sid, 57_000, [{ type: 'text', text: 'The test fails because `trust proxy` is set after the limiter reads `req.ip`. Fixing the order.' }]);
  tool(ctx, 60_000, 'A', sid, c, 'mcp__github__get_issue', { owner: 'example', repo: 'shop-api', issue_number: 42 }, [{ type: 'text', text: '{"number":42,"title":"Brute-force on /login","state":"open"}' }]);
  // subagent
  const agentInput = { description: 'Review the limiter for edge cases', prompt: 'Review src/middleware/rateLimit.ts for memory growth and proxy issues.', subagent_type: 'general-purpose' };
  const agentTool = toolId();
  assistantLine(ctx, sid, 64_000, [{ type: 'tool_use', id: agentTool, name: 'Agent', input: agentInput }]);
  step(ctx, 64_000, 'A', { ...b, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: agentInput, tool_use_id: agentTool });
  step(ctx, 64_500, 'A', { ...b, hook_event_name: 'SubagentStart', agent_id: 'agent-fx-review', agent_type: 'general-purpose' });
  tool(ctx, 66_000, 'A', sid, c, 'Read', { file_path: `${c}\\src\\middleware\\rateLimit.ts` }, { type: 'text', file: { filePath: `${c}\\src\\middleware\\rateLimit.ts`, numLines: 12 } }, { agentId: 'agent-fx-review' });
  tool(ctx, 70_000, 'A', sid, c, 'Grep', { pattern: 'trust proxy', path: 'src' }, { mode: 'files_with_matches', numFiles: 1, filenames: ['src/app.ts'] }, { agentId: 'agent-fx-review' });
  step(ctx, 76_000, 'A', { ...b, hook_event_name: 'SubagentStop', agent_id: 'agent-fx-review', agent_type: 'general-purpose', stop_hook_active: false, last_assistant_message: 'The map never shrinks for idle IPs; prune on an interval.' });
  step(ctx, 76_500, 'A', { ...b, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: agentInput, tool_use_id: agentTool, tool_response: { content: [{ type: 'text', text: 'The map never shrinks for idle IPs; prune on an interval.' }], totalDurationMs: 12000 } });
  tool(ctx, 80_000, 'A', sid, c, 'Bash', { command: 'npm test', description: 'Run test suite' }, { stdout: 'PASS test/auth.test.ts\n  ✓ returns 429 after 5 attempts (9 ms)\n\nTests: 14 passed, 14 total', stderr: '', interrupted: false }, { dur: 5400 });
  // AskUserQuestion with a permission request
  const askInput = { questions: [{ question: 'Should the limit also apply to /register?', header: 'Scope', multiSelect: false, options: [{ label: 'Yes', description: 'Same limiter on both routes' }, { label: 'No', description: 'Only /login' }] }] };
  const askId = toolId();
  step(ctx, 88_000, 'A', { ...b, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: askInput, tool_use_id: askId });
  step(ctx, 88_200, 'A', { ...b, hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: askInput });
  step(ctx, 88_300, 'A', { ...b, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use AskUserQuestion' });
  step(ctx, 120_000, 'A', { ...b, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: askInput, tool_use_id: askId, tool_response: { questions: askInput.questions, answers: { 'Should the limit also apply to /register?': 'Yes' } } });
  // plan
  tool(ctx, 124_000, 'A', sid, c, 'ExitPlanMode', { plan: '## Plan\n\n1. Apply `rateLimit()` to `/register`\n2. Prune idle IPs every minute\n3. Commit and open a PR' }, { plan: 'approved' });
  // commit
  tool(ctx, 130_000, 'A', sid, c, 'Bash', { command: 'git add -A && git commit -m "Add login rate limiting"' }, { stdout: '[feat/rate-limit 9f8e7d6] Add login rate limiting\n 3 files changed, 18 insertions(+), 2 deletions(-)', stderr: '', interrupted: false }, {
    git: git(c, 'feat/rate-limit', '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', { ahead: 1, lastCommit: { sha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', message: 'Add login rate limiting', author: 'Dev', ts: ctx.t0 + 130_000, files: 3, added: 18, removed: 2 } }),
  });
  assistantLine(ctx, sid, 136_000, [{ type: 'text', text: 'Done. Login is limited to **5 attempts per minute per IP**, tests pass, and the change is committed on `feat/rate-limit`.' }]);
  line(ctx, sid, 136_500, { type: 'cost-state', totalCostUSD: 0.4213, totalLinesAdded: 18, totalLinesRemoved: 2 });
  step(ctx, 137_000, 'A', { ...b, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done. Login is limited to 5 attempts per minute per IP.' }, {
    git: git(c, 'feat/rate-limit', '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', { ahead: 1, shortstat: ' 3 files changed, 18 insertions(+), 2 deletions(-)' }),
    progress: { hash: 'fxprogress1', content: '# Progress\n\n## Done\n- M1 rate limiter\n\n## Decisions\n- In-memory map, pruned every minute\n\n## Next\n- Open the PR\n' },
  });
}

function session2(ctx: Ctx, offset: number) {
  const sid = S2;
  const c = CWD2;
  const b = { session_id: sid, cwd: c, transcript_path: tp(sid) };
  const at = (ms: number) => offset + ms;
  step(ctx, at(0), 'A', { ...b, hook_event_name: 'SessionStart', source: 'startup' }, { git: git(c, 'main', 'c0ffee00112233445566778899aabbccddeeff00', { dirty: 2 }) });
  line(ctx, sid, at(1), { type: 'ai-title', aiTitle: SESSION_NAMES[S2] });
  const prompt = 'Refactor the CSV billing export into a streaming writer.';
  step(ctx, at(1_000), 'A', { ...b, hook_event_name: 'UserPromptSubmit', prompt });
  userLine(ctx, sid, at(1_000), prompt);
  assistantLine(ctx, sid, at(3_000), [{ type: 'text', text: 'Starting with the export module.' }], { input_tokens: 9000, output_tokens: 600, cache_read_input_tokens: 150000, cache_creation_input_tokens: 4000 });
  tool(ctx, at(5_000), 'A', sid, c, 'Read', { file_path: `${c}\\src\\export\\csv.ts` }, { type: 'text', file: { filePath: `${c}\\src\\export\\csv.ts`, numLines: 310 } });
  step(ctx, at(10_000), 'A', { ...b, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null });
  line(ctx, sid, at(10_500), { type: 'system', subtype: 'compact_boundary', uuid: uuid(sid), content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 168000 } });
  step(ctx, at(25_000), 'A', { ...b, hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'Refactoring CSV export to streams.' });
  tool(ctx, at(30_000), 'A', sid, c, 'Bash', { command: 'npm run build' }, { stdout: 'built in 2.1s', stderr: '', interrupted: false }, { dur: 2100 });
  // a permission request still waiting on me
  const input = { command: 'rm -rf dist && npm run build:prod', description: 'Clean and rebuild' };
  step(ctx, at(40_000), 'A', { ...b, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: input, tool_use_id: toolId() });
  step(ctx, at(40_200), 'A', { ...b, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run build:prod' }], behavior: 'allow', destination: 'localSettings' }] });
  step(ctx, at(40_300), 'A', { ...b, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
}

function session3(ctx: Ctx, offset: number) {
  const sid = S3;
  const c = CWD3;
  const b = { session_id: sid, cwd: c, transcript_path: tp(sid) };
  const at = (ms: number) => offset + ms;
  step(ctx, at(0), 'B', { ...b, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-haiku-5-5' }, { git: git(c, 'chore/deps', '0123456789abcdef0123456789abcdef01234567') });
  line(ctx, sid, at(1), { type: 'ai-title', aiTitle: SESSION_NAMES[S3] });
  const prompt = 'Update all minor dependency versions and run the tests.';
  step(ctx, at(1_000), 'B', { ...b, hook_event_name: 'UserPromptSubmit', prompt });
  userLine(ctx, sid, at(1_000), prompt);
  assistantLine(ctx, sid, at(2_000), [{ type: 'text', text: 'Checking outdated packages.' }]);
  tool(ctx, at(4_000), 'B', sid, c, 'Bash', { command: 'npm outdated --json' }, { stdout: '{"vite":{"current":"8.1.0","wanted":"8.3.4"}}', stderr: '', interrupted: false });
  tool(ctx, at(9_000), 'B', sid, c, 'Bash', { command: 'npm update && npm test' }, null, { fail: 'Exit code 1\nnpm ERR! network request failed', dur: 30_000 });
  line(ctx, sid, at(40_000), { type: 'bb-unknown-future-line', note: 'unknown line types must show as raw' });
  step(ctx, at(41_000), 'B', { ...b, hook_event_name: 'StopFailure', error: 'rate_limit', message: 'API rate limit reached (429). Resets in 42 minutes.' });
  step(ctx, at(42_000), 'B', { ...b, hook_event_name: 'SessionEnd', reason: 'other' });
}

/** Builds the scenario. `t0` is the timestamp of the first step. */
export function buildScenario(t0: number): { steps: Step[]; durationMs: number } {
  uuidN = 0;
  toolN = 0;
  const ctx: Ctx = { steps: [], transcripts: new Map(), t0 };
  session1(ctx);
  session3(ctx, 140_000);
  session2(ctx, 200_000);
  ctx.steps.sort((a, b) => a.at - b.at);
  // attach transcript deltas: each transcript-carrying event gets the lines written since the previous one
  const sent = new Map<string, number>();
  for (const s of ctx.steps) {
    const e = s.envelope.event;
    if (!['PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd', 'UserPromptSubmit', 'StopFailure'].includes(e.hook_event_name)) continue;
    const all = ctx.transcripts.get(e.session_id) ?? [];
    const upto = all.filter((l) => Date.parse(JSON.parse(l).timestamp) <= s.envelope.ts);
    const from = sent.get(e.session_id) ?? 0;
    if (upto.length > from) {
      s.envelope.transcripts = [{ path: String(e.transcript_path), offset: from, lines: upto.slice(from) }];
      sent.set(e.session_id, upto.length);
    }
  }
  // flush any remaining lines on each session's last step
  for (const [sid, all] of ctx.transcripts) {
    const from = sent.get(sid) ?? 0;
    if (from >= all.length) continue;
    const last = [...ctx.steps].reverse().find((s) => s.envelope.event.session_id === sid)!;
    const t = (last.envelope.transcripts ??= [{ path: String(last.envelope.event.transcript_path), offset: from, lines: [] }]);
    t[0].lines.push(...all.slice(from));
  }
  const durationMs = ctx.steps[ctx.steps.length - 1].at;
  return { steps: ctx.steps, durationMs };
}

/** Timestamp to start at so the scenario ends `endAgoMs` before now (S2 stays "waiting", not stale). */
export function scenarioStart(now = Date.now(), endAgoMs = 1 * MIN): number {
  const { durationMs } = buildScenario(0);
  return now - endAgoMs - durationMs;
}

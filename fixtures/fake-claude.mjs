#!/usr/bin/env node
// A fake `claude` for runner tests. Speaks just enough of headless stream-json:
//   claude --version                 -> prints a version
//   claude agents --json --all       -> prints fixtures/stream-json/agents.json
//   claude -p --output-format stream-json --input-format stream-json --verbose ...
//       reads user messages from stdin and answers with fixture lines (fixtures/stream-json/basic.jsonl).
// Prompt keywords change the behaviour: WAIT (no result until a follow-up arrives), FAIL (error result,
// exit 1), STUBBORN (ignores stdin end, so only a kill stops it). Follow-ups are echoed back.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const val = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

if (argv[0] === '--version') {
  console.log('9.9.9 (Fake Claude)');
  process.exit(0);
}
if (argv[0] === 'agents') {
  process.stdout.write(readFileSync(join(here, 'stream-json', 'agents.json'), 'utf8'));
  process.exit(0);
}

const need = ['-p', '--verbose'];
const bad = need.filter((f) => !argv.includes(f));
if (val('--output-format') !== 'stream-json') bad.push('--output-format stream-json');
if (val('--input-format') !== 'stream-json') bad.push('--input-format stream-json');
if (!argv.includes('--session-id') && !argv.includes('--resume')) bad.push('--session-id or --resume');
if (argv.includes('--session-id') && argv.includes('--resume')) bad.push('not both --session-id and --resume');
if (bad.length) {
  process.stderr.write(`fake-claude: missing/invalid flags: ${bad.join(', ')}\n`);
  process.exit(2);
}

const sessionId = val('--session-id') ?? val('--resume');
const fill = (s) => s.replaceAll('{{SESSION_ID}}', sessionId).replaceAll('{{CWD}}', JSON.stringify(process.cwd()).slice(1, -1));
const fixture = readFileSync(join(here, 'stream-json', 'basic.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(fill(l)));
const init = { ...fixture[0], fake_argv: argv, fake_job_id: process.env.BUILDYBOY_JOB_ID ?? null };

// with --json-schema, results carry a canned structured_output (Spec-ify)
const structured = argv.includes('--json-schema') ? { structured_output: { goal: 'Fake goal', doneWhen: ['`npm test` passes'], scope: 'src/', spec: '# Draft spec' } } : {};
let cost = 0;
let turns = 0;
let mode = 'normal';
const result = (text, isError = false) => {
  cost += 0.0123;
  turns++;
  out({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, duration_ms: 50, num_turns: turns, result: text, session_id: sessionId, total_cost_usd: Number(cost.toFixed(4)), permission_denials: [], ...structured });
};
const say = (text) => out({ type: 'assistant', message: { id: `msg_fake_${Date.now()}`, type: 'message', role: 'assistant', model: 'claude-fake-1', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: sessionId });

let first = true;
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`fake-claude: stdin line is not JSON: ${line.slice(0, 80)}\n`);
    return;
  }
  if (msg.type !== 'user' || msg.message?.role !== 'user') {
    process.stderr.write(`fake-claude: unexpected stdin message type ${msg.type}\n`);
    return;
  }
  const text = typeof msg.message.content === 'string' ? msg.message.content : JSON.stringify(msg.message.content);
  if (first) {
    first = false;
    out(init);
    if (text.includes('FAIL')) {
      say('Something went wrong.');
      result('failed on purpose', true);
      setTimeout(() => process.exit(1), 20);
    } else if (text.includes('WAIT') || text.includes('STUBBORN')) {
      mode = text.includes('STUBBORN') ? 'stubborn' : 'wait';
      say('Waiting for a follow-up message.');
      if (mode === 'stubborn') setInterval(() => {}, 1000);
    } else {
      for (const l of fixture.slice(1, -1)) out(l);
      out({ ...fixture[fixture.length - 1], ...structured });
      cost = fixture[fixture.length - 1].total_cost_usd;
      turns = 2;
    }
    return;
  }
  say(`Echo: ${text}`);
  result(`Echo: ${text}`);
});
rl.on('close', () => {
  if (mode !== 'stubborn') setTimeout(() => process.exit(0), 20);
});
process.on('SIGINT', () => process.exit(130));

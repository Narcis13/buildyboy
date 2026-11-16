#!/usr/bin/env node
// A fake `claude` for the kit's verifiers (runner/kit/verifier.ts): `claude -p --output-format json [--json-schema …] … <prompt>`.
// Never calls a model. What it answers comes from the JSON file named by FAKE_CLAUDE_SCRIPT:
//   { "responses": [ { "structured_output": {…}, "result": "text", "cost": 0.12, "is_error": false,
//                      "writes": { "relative/path": "content" }, "git": [["add", "-A"], ["commit", "-m", "x"]], "exit": 0, "noJson": false } ] }
// Each call takes the next response (the last one repeats); `writes` and `git` run in its cwd first (the QA case).
// Every call is appended to FAKE_CLAUDE_LOG as one JSON line: { argv, cwd, env: { BB_TASK, BB_ROLE }, prompt }.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const val = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

if (argv[0] === '--version') {
  console.log('9.9.9 (Fake Claude JSON)');
  process.exit(0);
}

const bad = [];
if (!argv.includes('-p')) bad.push('-p');
if (val('--output-format') !== 'json') bad.push('--output-format json');
for (const f of ['--model', '--permission-mode', '--max-turns', '--max-budget-usd']) if (!val(f)) bad.push(f);
if (argv.includes('--json-schema')) {
  try {
    JSON.parse(val('--json-schema'));
  } catch {
    bad.push('--json-schema must be JSON');
  }
}
if (bad.length) {
  process.stderr.write(`fake-claude-json: missing/invalid flags: ${bad.join(', ')}\n`);
  process.exit(2);
}

const prompt = argv[argv.length - 1];
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, cwd: process.cwd(), env: { BB_TASK: process.env.BB_TASK ?? null, BB_ROLE: process.env.BB_ROLE ?? null }, prompt }) + '\n');
}

const scriptFile = process.env.FAKE_CLAUDE_SCRIPT;
const script = scriptFile && existsSync(scriptFile) ? JSON.parse(readFileSync(scriptFile, 'utf8')) : { responses: [{ result: 'ok' }] };
const counter = `${scriptFile ?? join(process.cwd(), '.fake-claude')}.count`;
const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) || 0 : 0;
writeFileSync(counter, String(n + 1));
const list = Array.isArray(script.responses) && script.responses.length ? script.responses : [{ result: 'ok' }];
const r = list[Math.min(n, list.length - 1)];

for (const [p, content] of Object.entries(r.writes ?? {})) {
  const abs = join(process.cwd(), p);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
for (const args of r.git ?? []) execFileSync('git', args, { cwd: process.cwd(), stdio: 'ignore' });

if (r.noJson) {
  console.log('not json at all');
  process.exit(r.exit ?? 1);
}
const out = {
  type: 'result', subtype: r.is_error ? 'error_during_execution' : 'success', is_error: !!r.is_error, duration_ms: 10, num_turns: 3,
  result: r.result ?? 'done', session_id: `fake-${n + 1}`, total_cost_usd: r.cost ?? 0.01,
  ...(r.structured_output !== undefined ? { structured_output: r.structured_output } : {}),
};
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(r.exit ?? 0);

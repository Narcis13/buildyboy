#!/usr/bin/env node
// A fake herdr `hc` for runner tests. Never touches a real herdr.
//   hc ls --json        -> prints the file named by FAKE_HC_TERMINALS ({"terminals":[…]}), else an empty list
//   hc run --bg --json  -> appends its whole argv (one JSON array per line) to the file named by FAKE_HC_LOG
//                          and prints the new terminal as hc does: {"address":"tN","agent":…,"cwd":…,"name":…,"state":"live","turn":0}
//   FAKE_HC_FAIL=msg    -> `run` prints msg on stderr and exits 1 (like a name already in use)
//   hc get <t> --json   -> the terminal of FAKE_HC_TERMINALS whose name or address is <t> (with its labels), else exit 1
//   hc send [--json] [--if s] <t> <text>, hc kill [--json] <t>
//                       -> append their argv to FAKE_HC_LOG; send with --if fails (exit 1) when the terminal's status differs
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const findTerminal = (t) => {
  const file = process.env.FAKE_HC_TERMINALS;
  const all = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  return all.find((x) => x.name === t || x.address === t);
};
const positionals = (args) => args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--if'));

const argv = process.argv.slice(2);
const val = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

if (argv[0] === '--version') {
  console.log('hc 0.0.0 (fake)');
} else if (argv[0] === 'ls') {
  const file = process.env.FAKE_HC_TERMINALS;
  const terminals = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  console.log(JSON.stringify({ hidden_finished: 0, terminals }));
} else if (argv[0] === 'run') {
  if (process.env.FAKE_HC_FAIL) {
    process.stderr.write(`${process.env.FAKE_HC_FAIL}\n`);
    process.exit(1);
  }
  const log = process.env.FAKE_HC_LOG;
  const runs = log && existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
  if (log) appendFileSync(log, JSON.stringify(argv) + '\n');
  console.log(JSON.stringify({ address: `t${runs + 7}`, agent: 'claude-code', cwd: val('--cwd') ?? process.cwd(), name: val('--name'), state: 'live', turn: 0 }));
} else if (argv[0] === 'get') {
  const t = findTerminal(positionals(argv.slice(1))[0]);
  if (!t) {
    process.stderr.write('error: no such terminal\n');
    process.exit(1);
  }
  console.log(JSON.stringify({ labels: {}, state: 'live', status: null, ...t }));
} else if (argv[0] === 'send' || argv[0] === 'kill') {
  const [name] = positionals(argv.slice(1));
  const t = findTerminal(name);
  if (!t) {
    process.stderr.write('error: no such terminal\n');
    process.exit(1);
  }
  if (argv[0] === 'send' && val('--if') && val('--if') !== (t.status ?? null)) {
    process.stderr.write(`error: ${name} is ${t.status ?? 'unknown'}, not ${val('--if')}\n`);
    process.exit(1);
  }
  if (process.env.FAKE_HC_LOG) appendFileSync(process.env.FAKE_HC_LOG, JSON.stringify(argv) + '\n');
  console.log(JSON.stringify({ ok: true }));
} else {
  process.stderr.write(`fake-hc: unsupported command ${argv.join(' ')}\n`);
  process.exit(2);
}

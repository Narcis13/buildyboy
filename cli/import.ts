// bb import [--dir <path>] [--since <days>]: uploads existing transcripts from ~/.claude/projects to the server.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readClientConfig } from './config.ts';

const CHUNK_BYTES = 1024 * 1024;

export async function importTranscripts(args: string[]) {
  const { values } = parseArgs({ args, options: { dir: { type: 'string' }, since: { type: 'string' } } });
  const cfg = readClientConfig();
  if (!cfg.url || !cfg.token) {
    console.error('not paired: run `bb pair <url> <code>` first (or set BUILDYBOY_URL and BUILDYBOY_TOKEN)');
    process.exit(1);
  }
  const root = values.dir ?? join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) {
    console.error(`no transcripts at ${root}`);
    process.exit(1);
  }
  const since = values.since ? Date.now() - Number(values.since) * 86400_000 : 0;
  const files: string[] = [];
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.jsonl') && statSync(join(dir, f)).mtimeMs >= since) files.push(join(dir, f));
  }
  const total = files.reduce((n, f) => n + statSync(f).size, 0);
  let done = 0;
  let sessions = 0;
  const bar = () => {
    const pct = total ? done / total : 1;
    const w = 30;
    process.stdout.write(`\r[${'#'.repeat(Math.round(pct * w)).padEnd(w, '.')}] ${(pct * 100).toFixed(0).padStart(3)}%  ${sessions}/${files.length} sessions`);
  };
  for (const file of files) {
    const sessionId = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    let chunk: string[] = [];
    let bytes = 0;
    const flush = async () => {
      if (!chunk.length) return;
      const res = await fetch(`${cfg.url}/api/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ sessionId, path: file, lines: chunk }),
      });
      if (!res.ok) throw new Error(`import failed for ${sessionId}: ${res.status} ${await res.text()}`);
      done += bytes;
      chunk = [];
      bytes = 0;
      bar();
    };
    for (const l of lines) {
      chunk.push(l);
      bytes += l.length + 1;
      if (bytes > CHUNK_BYTES) await flush();
    }
    await flush();
    sessions++;
    bar();
  }
  process.stdout.write('\n');
  console.log(`imported ${sessions} transcripts (${(total / 1e6).toFixed(1)} MB)`);
}

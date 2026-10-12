#!/usr/bin/env node
// bb — Buildyboy command line.
//   bb server                      start the server (same as npm start)
//   bb runner [--config <file>]    start the job runner daemon on this machine
//   bb pair <url> <code> [name]    pair this machine (writes ~/.buildyboy/config.json)
//   bb set-password                set the web password (reads it from stdin or BB_PASSWORD)
//   bb token <machine-name>        create a machine and print its token (server host only)
//   bb import [--dir <path>]       backfill transcripts from ~/.claude/projects
//   bb backup [--out <file>]       online SQLite backup
//   bb doctor                      check config, server reachability and spool
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { configFromEnv, createContext } from '../server/main.ts';
import { createMachine, setPassword } from '../server/auth.ts';

const [cmd, ...rest] = process.argv.slice(2);

async function readSecret(): Promise<string> {
  if (process.env.BB_PASSWORD) return process.env.BB_PASSWORD;
  if (process.stdin.isTTY) process.stderr.write('New password: ');
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function localCtx() {
  return createContext(configFromEnv());
}

switch (cmd) {
  case 'server':
  case undefined: {
    const { startServer } = await import('../server/main.ts');
    const s = await startServer();
    process.on('SIGINT', () => s.close().then(() => process.exit(0)));
    process.on('SIGTERM', () => s.close().then(() => process.exit(0)));
    break;
  }
  case 'runner': {
    const { runRunner } = await import('../runner/main.ts');
    await runRunner(rest);
    break;
  }
  case 'pair': {
    const { pairMachine } = await import('./pair.ts');
    await pairMachine(rest);
    break;
  }
  case 'set-password': {
    const pw = await readSecret();
    if (pw.length < 8) {
      console.error('password must be at least 8 characters');
      process.exit(1);
    }
    const ctx = localCtx();
    setPassword(ctx, pw);
    ctx.db.audit('cli', 'set_password');
    ctx.db.close();
    console.log('password set');
    break;
  }
  case 'token': {
    const name = rest[0];
    if (!name) {
      console.error('usage: bb token <machine-name>');
      process.exit(1);
    }
    const ctx = localCtx();
    const m = createMachine(ctx, name);
    ctx.db.audit('cli', 'machine_token', m.id);
    ctx.db.close();
    console.log(JSON.stringify({ machineId: m.id, token: m.token }));
    break;
  }
  case 'backup': {
    const { values } = parseArgs({ args: rest, options: { out: { type: 'string' } } });
    const { backupDb } = await import('../server/backup.ts');
    const cfg = configFromEnv();
    const out = resolve(values.out ?? join(cfg.dataDir, 'backups', `buildyboy-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
    await backupDb(join(cfg.dataDir, 'buildyboy.db'), out);
    console.log(out);
    break;
  }
  case 'import': {
    const { importTranscripts } = await import('./import.ts');
    await importTranscripts(rest);
    break;
  }
  case 'doctor': {
    const { doctor } = await import('./doctor.ts');
    process.exitCode = await doctor();
    break;
  }
  default:
    console.error(`unknown command: ${cmd}\nusage: bb server | runner | pair | set-password | token | import | backup | doctor`);
    process.exit(1);
}

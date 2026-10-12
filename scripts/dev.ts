// Dev mode: API server with --watch on :7700 plus the Vite dev server on :5173 (proxying /api).
import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['--watch-path=server', '--watch-path=shared', 'server/main.ts'], { stdio: 'inherit', env: { ...process.env, BUILDYBOY_PUBLIC_URL: process.env.BUILDYBOY_PUBLIC_URL ?? 'http://localhost:5173' } }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'web/vite.config.ts'], { stdio: 'inherit' }),
];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());

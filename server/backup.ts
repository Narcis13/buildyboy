import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Online backup with node:sqlite backup(). Keeps the newest `keep` files in the target directory. */
export async function backupDb(dbPath: string, outPath: string, keep = 14): Promise<void> {
  mkdirSync(dirname(outPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    await backup(db, outPath);
  } finally {
    db.close();
  }
  const dir = dirname(outPath);
  const files = readdirSync(dir).filter((f) => /^buildyboy-.*\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f), { force: true });
}

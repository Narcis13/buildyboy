import type { DB } from './db.ts';

/** Adds text to the FTS index. `ref` deep-links to the timeline item. */
export function indexText(db: DB, kind: string, ref: string, sessionId: string | null, text: string) {
  if (!text) return;
  db.run('INSERT INTO search_index (kind, ref, session_id, text) VALUES (?, ?, ?, ?)', kind, ref, sessionId, text.slice(0, 20000));
}

export interface SearchHit {
  kind: string;
  ref: string;
  sessionId: string | null;
  snippet: string;
}

export function search(db: DB, q: string, limit = 50): SearchHit[] {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/["]/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"*`);
  if (!terms.length) return [];
  try {
    return db.all<SearchHit>(
      `SELECT kind, ref, session_id AS sessionId, snippet(search_index, 3, '[', ']', '…', 12) AS snippet
       FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT ?`,
      terms.join(' '), limit,
    );
  } catch {
    return [];
  }
}

// search.ts: FTS5 symbol search — deck's upgrade over dextree, which only has
// exact fqn lookups. Deterministic order (rank desc, fqn asc); content lives
// in the symbols_fts virtual table the indexer maintains.
import type { Database } from 'bun:sqlite';

export interface SearchHit {
  id: string;
  name: string;
  fqn: string;
  fileId: string;
}

export function searchSymbols(db: Database, text: string, limit = 25): SearchHit[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const needle = trimmed.split(/\s+/).map((word) => `"${word.replace(/"/g, '')}"*`).join(' ');
  const rows = db
    .query('SELECT file_id, name, fqn FROM symbols_fts WHERE symbols_fts MATCH ? ORDER BY rank, fqn LIMIT ?')
    .all(needle, limit) as Array<{ file_id: string; name: string; fqn: string }>;
  return rows.map((row) => ({
    id: (db.query('SELECT id FROM g_symbol WHERE fqn = ?').get(row.fqn) as { id: string } | null)?.id ?? row.fqn,
    name: row.name,
    fqn: row.fqn,
    fileId: row.file_id,
  }));
}

// Session memory + recall (memory-recall, P2 deck-born): per-card
// append-only session files under .deck/sessions/, synced into an FTS5
// index, queried through the pinned `recall(query)→string[]` contract.
// Pinned contracts in this header (specstore style):
//   recall(store, query) → string[]   — ranked `<cardId> <section>: <line>`
//   scaffoldSession(...) → void       — the verb start flow scaffolds the file
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentStore } from './store.ts';

export const SESSIONS_DIR = '.deck/sessions';

export function sessionPath(projectPath: string, cardId: string): string {
  return join(projectPath, SESSIONS_DIR, `${cardId}.md`);
}

// The pinned session file format, byte-exact:
//   card: <id>
//   verb: <verb>
//   branch: <branch>
//
//   ## Learnings
//
//   ## Decisions
//
//   ## Gotchas
export function scaffoldSession(projectPath: string, cardId: string, verb: string, branch: string): void {
  const path = sessionPath(projectPath, cardId);
  if (existsSync(path)) return; // append-only: never overwrite lived-in memory
  mkdirSync(join(projectPath, SESSIONS_DIR), { recursive: true });
  writeFileSync(
    path,
    `card: ${cardId}\nverb: ${verb}\nbranch: ${branch}\n\n## Learnings\n\n## Decisions\n\n## Gotchas\n`,
  );
}

interface Bullet {
  cardId: string;
  section: string;
  line: string;
}

function parseSession(cardId: string, markdown: string): Bullet[] {
  const bullets: Bullet[] = [];
  let section = '';
  for (const raw of markdown.split('\n')) {
    const heading = /^## (.+)$/.exec(raw.trim());
    if (heading !== null) {
      section = heading[1]!.trim();
      continue;
    }
    const bullet = /^- (.+)$/.exec(raw.trim());
    if (bullet !== null && section.length > 0) {
      bullets.push({ cardId, section, line: bullet[1]!.trim() });
    }
  }
  return bullets;
}

// One row per bullet; the index is a derived view, rebuilt from the files
// only when they changed (files are the source of truth, never the index).
export function syncMemory(store: DocumentStore, force = false): number {
  const dir = join(store.projectPath, SESSIONS_DIR);
  const db = store.raw();
  // Cheap freshness probe: newest mtime across the sessions dir. recall()
  // runs on every deck next — a full rescan per call is deadweight.
  const stamp = dirStamp(dir);
  if (!force && stamp !== null && stamp === lastSyncStamp.get(store.projectPath)) {
    const row = db.query('SELECT COUNT(*) AS n FROM session_memory').get() as { n: number };
    return row.n;
  }
  const bullets: Bullet[] = [];
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.md')).sort()) {
      const cardId = file.slice(0, -3);
      bullets.push(...parseSession(cardId, readFileSync(join(dir, file), 'utf8')));
    }
  }
  db.run('DELETE FROM session_memory');
  for (const bullet of bullets) {
    const escaped = bullet.line.replaceAll("'", "''");
    const card = bullet.cardId.replaceAll("'", "''");
    const sect = bullet.section.replaceAll("'", "''");
    db.run(`INSERT INTO session_memory (line, cardId, section) VALUES ('${escaped}', '${card}', '${sect}')`);
  }
  lastSyncStamp.set(store.projectPath, stamp);
  return bullets.length;
}

const lastSyncStamp = new Map<string, number | null>();

function dirStamp(dir: string): number | null {
  if (!existsSync(dir)) return null;
  let newest = 0;
  for (const file of readdirSync(dir)) {
    const mtime = statSync(join(dir, file)).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

// Pinned contract: recall(query)→string[] — top FTS5-ranked bullets as
// `<cardId> <section>: <line>`; empty query / empty index / no match → [].
export function recall(store: DocumentStore, query: string, limit = 10): string[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  syncMemory(store);
  const db = store.raw();
  // OR across the user's words so partial queries still hit; bm25 ranks.
  const terms = trimmed
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word.replaceAll('"', '""')}*`)
    .join(' OR ');
  let rows: Array<{ line: string; cardId: string; section: string }> = [];
  try {
    rows = db
      .query(
        `SELECT line, cardId, section FROM session_memory WHERE session_memory MATCH '${terms.replaceAll("'", "''")}' ORDER BY bm25(session_memory) LIMIT ${limit}`,
      )
      .all() as Array<{ line: string; cardId: string; section: string }>;
  } catch {
    return []; // malformed match syntax → no recall, never a crash
  }
  return rows.map((row) => `${row.cardId} ${row.section}: ${row.line}`);
}

// Session memory + recall (memory-recall, P2 deck-born; E02 DECK-ARCH-006):
// per-card session files under .deck/sessions/ are the authoritative store;
// the FTS5 session_memory index is a derived projection, rebuilt
// transactionally when an inventory/content signature changes.
// Pinned contracts in this header (specstore style):
//   recall(store, query) → string[]   — ranked `<cardId> <section>: <line>`
//   recallDetail(store, query)        — same results + a diagnostic status
//                                       distinguishing no-hit from stale/error
//   scaffoldSession(...) → void       — the verb start flow scaffolds the file
// Query policy (documented, literal): user text is split on whitespace; each
// word is bound as a quoted FTS5 term with a trailing prefix star. Punctuation
// inside a term is tokenizer input, never FTS5 query syntax — quotes,
// operators and column filters in user text cannot change the query's shape.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { DocumentStore } from './store.ts';

export const SESSIONS_DIR = '.deck/sessions';
// deck_meta key recording the signature of the bytes actually indexed.
export const MEMORY_INDEX_KEY = 'memory_index_signature';
// Bumping this prefix forces one rebuild after a format change — the stored
// signature can never look fresh across an upgrade.
const SIGNATURE_VERSION = 'v2';

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

// The freshness probe is content, not mtime: relative filename, byte length
// and a sha256 of the bytes, sorted — preserved-mtime edits, renames and
// deletions all move it. Null means no sessions dir (recorded as `none`).
function inventorySignature(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
  if (files.length === 0) return `${SIGNATURE_VERSION}:empty`;
  const hasher = new Bun.CryptoHasher('sha256');
  for (const file of files) {
    const bytes = readFileSync(join(dir, file));
    hasher.update(file);
    hasher.update('\0');
    hasher.update(String(bytes.byteLength));
    hasher.update('\0');
    hasher.update(new Bun.CryptoHasher('sha256').update(bytes).digest());
    hasher.update('\0');
  }
  return `${SIGNATURE_VERSION}:${hasher.digest('hex')}`;
}

function storedSignature(db: Database): string | null {
  const table = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='deck_meta'")
    .get();
  if (table === undefined || table === null) return null;
  const row = db.query('SELECT value FROM deck_meta WHERE key = ?').get(MEMORY_INDEX_KEY) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

function storeSignature(db: Database, signature: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS deck_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
  db.prepare(
    'INSERT INTO deck_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(MEMORY_INDEX_KEY, signature);
}

// Collect → BEGIN IMMEDIATE → DELETE + bound INSERTs → COMMIT. The signature
// is recorded only after commit; a failure anywhere keeps the prior committed
// index untouched. A source change during collection refuses to commit a
// mixed snapshot (code 'stale').
function rebuildIndex(dir: string, db: Database): { ok: true; count: number } | { ok: false; code: 'stale' | 'error'; error: string } {
  const before = inventorySignature(dir);
  try {
    const bullets: Bullet[] = [];
    if (existsSync(dir)) {
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.md')).sort()) {
        const cardId = file.slice(0, -3);
        bullets.push(...parseSession(cardId, readFileSync(join(dir, file), 'utf8')));
      }
    }
    if (inventorySignature(dir) !== before) {
      return { ok: false, code: 'stale', error: 'session sources changed while indexing — retry' };
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM session_memory');
      const insert = db.prepare('INSERT INTO session_memory (line, cardId, section) VALUES (?, ?, ?)');
      for (const bullet of bullets) insert.run(bullet.line, bullet.cardId, bullet.section);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true, count: bullets.length };
  } catch (error) {
    return { ok: false, code: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

export interface MemoryIndexStatus {
  status: 'fresh' | 'stale' | 'error';
  bullets: number;
  error?: string | undefined;
}

const lastSignature = new Map<string, string | null>();

// The full diagnostic sync: fresh (signature matches what this process or a
// sibling handle committed), stale (rebuild refused — sources in motion) or
// error (rebuild failed; the prior index stays usable). Never throws.
export function syncMemoryDetail(store: DocumentStore, force = false): MemoryIndexStatus {
  const dir = join(store.projectPath, SESSIONS_DIR);
  const db = store.raw();
  const count = () => (db.query('SELECT COUNT(*) AS n FROM session_memory').get() as { n: number }).n;
  let signature: string;
  try {
    signature = inventorySignature(dir) ?? `${SIGNATURE_VERSION}:none`;
  } catch (error) {
    // Unreadable dir: the last valid index stays usable, loudly.
    return { status: 'error', bullets: count(), error: error instanceof Error ? error.message : String(error) };
  }
  if (!force && signature === lastSignature.get(store.projectPath)) {
    return { status: 'fresh', bullets: count() };
  }
  if (!force && signature === storedSignature(db)) {
    lastSignature.set(store.projectPath, signature);
    return { status: 'fresh', bullets: count() };
  }
  const result = rebuildIndex(dir, db);
  if (!result.ok) {
    // Not cached: the next recall retries (bounded — one retry per recall call).
    return { status: result.code, bullets: count(), error: result.error };
  }
  storeSignature(db, signature);
  lastSignature.set(store.projectPath, signature);
  return { status: 'fresh', bullets: result.count };
}

// Legacy pinned shape: the bullet count of the last committed index state.
export function syncMemory(store: DocumentStore, force = false): number {
  return syncMemoryDetail(store, force).bullets;
}

// Status-only probe for digest/dispatch callers that don't query recall.
export function memoryStatus(store: DocumentStore): MemoryIndexStatus {
  return syncMemoryDetail(store);
}

export type RecallStatus = 'ok' | 'empty' | 'stale' | 'error';

export interface RecallResult {
  results: string[];
  status: RecallStatus;
  message?: string | undefined;
}

function queryIndex(db: Database, match: string, limit: number): Array<{ line: string; cardId: string; section: string }> {
  return db
    .query(
      'SELECT line, cardId, section FROM session_memory WHERE session_memory MATCH ? ORDER BY bm25(session_memory) LIMIT ?',
    )
    .all(match, limit) as Array<{ line: string; cardId: string; section: string }>;
}

// Diagnostic-bearing recall: 'ok' (hits), 'empty' (valid query, no hits),
// 'stale' (results come from the last valid index — a rebuild failed or
// sources moved mid-collection) and 'error' (query/index failure).
export function recallDetail(store: DocumentStore, query: string, limit = 10): RecallResult {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { results: [], status: 'empty', message: 'empty query — nothing to search' };
  let sync = syncMemoryDetail(store);
  if (sync.status !== 'fresh') {
    // Bounded retry once: mid-collection moves usually settle immediately.
    sync = syncMemoryDetail(store, true);
  }
  const terms = trimmed
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => `"${word.replaceAll('"', '""')}"*`)
    .join(' OR ');
  let rows: Array<{ line: string; cardId: string; section: string }>;
  try {
    rows = queryIndex(store.raw(), terms, limit);
  } catch (error) {
    return {
      results: [],
      status: 'error',
      message: `index query failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const results = rows.map((row) => `${row.cardId} ${row.section}: ${row.line}`);
  if (sync.status === 'error') {
    return {
      results,
      status: 'stale',
      message: `index rebuild failed — results come from the last valid index: ${sync.error ?? 'unknown cause'}`,
    };
  }
  if (sync.status === 'stale') {
    return {
      results,
      status: 'stale',
      message: `session sources changed while indexing — results may be incomplete: ${sync.error ?? 'retry'}`,
    };
  }
  if (results.length === 0) return { results: [], status: 'empty' };
  return { results, status: 'ok' };
}

// Pinned contract: recall(query)→string[] — top FTS5-ranked bullets as
// `<cardId> <section>: <line>`; empty query / empty index / no match → [].
// Callers that must distinguish no-hit from stale/error use recallDetail.
export function recall(store: DocumentStore, query: string, limit = 10): string[] {
  return recallDetail(store, query, limit).results;
}

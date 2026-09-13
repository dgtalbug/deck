// Open-time engine state (raw DDL drizzle migrations cannot own): idempotent
// ALTERs, registry seeds, and FTS5 — run on every DocumentStore.open.
import { realpathSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { DECK_VERSION } from '../../version.ts';
import { DeckError } from './errors.ts';

// Semver triple compare — numeric, tolerant of missing parts (0.6 < 0.6.1).
function versionValue(version: string): number {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return (parts[0] ?? 0) * 1_000_000 + (parts[1] ?? 0) * 1_000 + (parts[2] ?? 0);
}

function metaValue(sqlite: Database, key: string): string | null {
  // bun:sqlite .get() yields null (not undefined) on an empty result.
  const hasMeta =
    sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='deck_meta'")
      .get() != null;
  if (!hasMeta) return null;
  const row = sqlite.query('SELECT value FROM deck_meta WHERE key = ?').get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

// Writer-version fence: a database last written by a NEWER deck refuses an
// older binary up front — before migrations or any other write. Once
// reservations are enforced (0.6.0), pre-reservation writers must not touch
// the board; the recorded floor is how a knowing writer detects that rule.
export function assertWriterAllowed(sqlite: Database): void {
  const floor = metaValue(sqlite, 'min_writer_version');
  if (floor !== null && versionValue(floor) > versionValue(DECK_VERSION)) {
    throw new DeckError(
      `board database requires deck >= ${floor} (this binary is ${DECK_VERSION}) — upgrade deck before opening this project`,
      { required: floor, current: DECK_VERSION },
    );
  }
}

function recordWriterVersion(sqlite: Database): void {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS deck_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)',
  );
  sqlite
    .query(
      `INSERT INTO deck_meta (key, value) VALUES ('writer_version', ?) ` +
        `ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(DECK_VERSION);
  // The floor never moves down: the newest writer defines the minimum.
  const floor = metaValue(sqlite, 'min_writer_version');
  if (floor === null || versionValue(DECK_VERSION) > versionValue(floor)) {
    sqlite
      .query(
        `INSERT INTO deck_meta (key, value) VALUES ('min_writer_version', ?) ` +
          `ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(DECK_VERSION);
  }
}

// One-time upgrade sweep: a board with active/verify cards but no operations
// ledger predates execution ownership — those cards carry old effects nobody
// can vouch for, so each surfaces as a recovery-required operation that
// fences the checkout until an explicit reconcile releases it. Never guessed:
// no takeover, no timeout — the reconcile flow is the only release.
function sweepLegacyActiveWork(sqlite: Database, projectPath: string): void {
  const legacy = sqlite
    .query(
      `SELECT id FROM cards WHERE lane IN ('active', 'verify') ` +
        `AND id NOT IN (SELECT card_id FROM operations WHERE state IN ('active', 'recovery-required'))`,
    )
    .all() as Array<{ id: string }>;
  if (legacy.length === 0) return;
  const checkout = realpathSync(projectPath);
  const now = new Date().toISOString();
  const insert = sqlite.query(
    `INSERT INTO operations (id, card_id, kind, owner, checkout, state, created_at, updated_at) ` +
      `VALUES (?, ?, 'start', 'legacy', ?, 'recovery-required', ?, ?)`,
  );
  for (const card of legacy) {
    insert.run(`op-legacy-${card.id}`, card.id, checkout, now, now);
  }
}

export async function ensureEngineState(sqlite: Database, projectPath = '.'): Promise<void> {
  // Writer fence FIRST: read-only while the db is foreign-newer.
  assertWriterAllowed(sqlite);

  // Epic planning: cards.epic_id (idempotent ALTER; migrations predate it).
  const cols = sqlite.query("PRAGMA table_info('cards')").all() as Array<{
    name: string;
  }>;
  if (!cols.some((col) => col.name === 'epic_id')) {
    sqlite.exec('ALTER TABLE cards ADD COLUMN epic_id TEXT');
  }

  // User verbs ride raw DDL (migrations are generated for the core model;
  // this table is engine-registry state, idempotent on every open).
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS user_verbs (name TEXT PRIMARY KEY NOT NULL, registered_at TEXT NOT NULL)',
  );
  // Spec-type registry: raw DDL + pinned seed, like user_verbs above.
  const { ensureSpecTypes } = await import('./types-registry.ts');
  ensureSpecTypes(sqlite);
  // Agent-host adapter registry (harness slice): raw DDL + pinned seed.
  const { ensureAgentHosts } = await import('../projects/harness.ts');
  ensureAgentHosts(sqlite);
  // FTS5 over session-memory bullets (drizzle can't own virtual tables).
  sqlite.exec(
    'CREATE VIRTUAL TABLE IF NOT EXISTS session_memory USING fts5(line, cardId UNINDEXED, section UNINDEXED)',
  );
  // Execution ownership ledger (engine/ownership): raw DDL, idempotent.
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY NOT NULL,
      card_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      owner TEXT NOT NULL,
      checkout TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  sqlite.exec(
    'CREATE INDEX IF NOT EXISTS operations_checkout_state ON operations (checkout, state)',
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS operations_card_state ON operations (card_id, state)');
  sqlite.exec(
    'CREATE INDEX IF NOT EXISTS operations_owner ON operations (owner)',
  );
  recordWriterVersion(sqlite);
  // Crash recovery: rows still reserved/active belong to a previous process
  // (operations are created after open, so nothing here is ours) — they are
  // uncertain by definition and surface as recovery-required. Explicit
  // reconcile is the only release; there is no lease expiry or takeover.
  sqlite
    .query(`UPDATE operations SET state = 'recovery-required', updated_at = ? WHERE state IN ('reserved', 'active')`)
    .run(new Date().toISOString());
  // Legacy sweep runs once per board (after the floor exists, so later opens
  // skip it): pre-ledger active work becomes explicit recovery-required rows.
  const swept = metaValue(sqlite, 'legacy_ownership_swept');
  if (swept === null) {
    sweepLegacyActiveWork(sqlite, projectPath);
    sqlite
      .query("INSERT INTO deck_meta (key, value) VALUES ('legacy_ownership_swept', '1')")
      .run();
  }
  // Hold law sweep: clear legacy engine-lane blocked flags once per open.
  sqlite.exec(
    `UPDATE cards SET blocked_reason = NULL, blocked_at = NULL ` +
      `WHERE lane IN ('active', 'verify', 'done') AND blocked_reason IS NOT NULL`,
  );
}

import { realpathSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { DECK_VERSION } from '../../version.ts';
import { DeckError } from './errors.ts';
import { ensureCollaborationState } from './collaboration-state.ts';
import { metaValue, recordWriterVersion, versionValue } from './state-meta.ts';
import { ensureCapabilityState, ensureDeliveryState, ensurePlanningState } from './ensure-state-tables.ts';

export function assertWriterAllowed(sqlite: Database): void {
  const floor = metaValue(sqlite, 'min_writer_version');
  if (floor !== null && versionValue(floor) > versionValue(DECK_VERSION)) {
    throw new DeckError(
      `board database requires deck >= ${floor} (this binary is ${DECK_VERSION}) — upgrade deck before opening this project`,
      { required: floor, current: DECK_VERSION },
    );
  }
}

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
  assertWriterAllowed(sqlite);

  const cols = sqlite.query("PRAGMA table_info('cards')").all() as Array<{
    name: string;
  }>;
  if (!cols.some((col) => col.name === 'epic_id')) {
    sqlite.exec('ALTER TABLE cards ADD COLUMN epic_id TEXT');
  }
  if (!cols.some((col) => col.name === 'history_at')) {
    sqlite.exec('ALTER TABLE cards ADD COLUMN history_at TEXT');
  }
  if (!cols.some((col) => col.name === 'completed_at')) {
    sqlite.exec('ALTER TABLE cards ADD COLUMN completed_at TEXT');
    // Historical done records predate the column; documented fallback is the
    // last update time. Records begin live — rotation never happens here.
    sqlite.exec("UPDATE cards SET completed_at = updated_at WHERE lane = 'done' AND completed_at IS NULL");
  }
  sqlite.exec('CREATE INDEX IF NOT EXISTS cards_history ON cards (history_at, id)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS cards_completion ON cards (completed_at, id)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS cards_epic ON cards (epic_id)');

  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS user_verbs (name TEXT PRIMARY KEY NOT NULL, registered_at TEXT NOT NULL)',
  );
  const { ensureSpecTypes } = await import('./types-registry.ts');
  ensureSpecTypes(sqlite);
  const { ensureAgentHosts } = await import('../projects/harness.ts');
  ensureAgentHosts(sqlite);
  sqlite.exec(
    'CREATE VIRTUAL TABLE IF NOT EXISTS session_memory USING fts5(line, cardId UNINDEXED, section UNINDEXED)',
  );
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
  sqlite
    .query(`UPDATE operations SET state = 'recovery-required', updated_at = ? WHERE state IN ('reserved', 'active')`)
    .run(new Date().toISOString());
  const swept = metaValue(sqlite, 'legacy_ownership_swept');
  if (swept === null) {
    sweepLegacyActiveWork(sqlite, projectPath);
    sqlite
      .query("INSERT INTO deck_meta (key, value) VALUES ('legacy_ownership_swept', '1')")
      .run();
  }
  sqlite.exec(
    `UPDATE cards SET blocked_reason = NULL, blocked_at = NULL ` +
      `WHERE lane IN ('active', 'verify', 'done') AND blocked_reason IS NOT NULL`,
  );
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS source_baselines (
      id TEXT PRIMARY KEY NOT NULL,
      card_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      scope_revision INTEGER NOT NULL,
      path TEXT NOT NULL,
      digest TEXT NOT NULL,
      snapshot_path TEXT,
      graph_generation INTEGER,
      graph_fingerprint TEXT,
      created_at TEXT NOT NULL
    )`,
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS source_baselines_card ON source_baselines (card_id, version)');
  ensurePlanningState(sqlite);
  ensureDeliveryState(sqlite);
  ensureCapabilityState(sqlite);
  ensureCollaborationState(sqlite);
}

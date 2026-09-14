import { realpathSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { DECK_VERSION } from '../../version.ts';
import { DeckError } from './errors.ts';
import { ensureCollaborationState } from './collaboration-state.ts';

function versionValue(version: string): number {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return (parts[0] ?? 0) * 1_000_000 + (parts[1] ?? 0) * 1_000 + (parts[2] ?? 0);
}

function metaValue(sqlite: Database, key: string): string | null {
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
  ensureCollaborationState(sqlite);
}

function ensurePlanningState(sqlite: Database): void {
  const cols = sqlite.query("PRAGMA table_info('cards')").all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === 'scope_revision')) {
    sqlite.exec('ALTER TABLE cards ADD COLUMN scope_revision INTEGER');
  }
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS scope_revisions (
      card_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      digest TEXT NOT NULL,
      operations TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (card_id, revision)
    )`,
  );
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS scope_items (
      card_id TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      first_revision INTEGER NOT NULL,
      last_revision INTEGER NOT NULL,
      PRIMARY KEY (card_id, id)
    )`,
  );
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS epic_intent (
      epic_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      intent TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS epic_criteria (
      epic_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      deferral TEXT,
      first_revision INTEGER NOT NULL,
      PRIMARY KEY (epic_id, id)
    )`,
  );
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS epic_criterion_links (
      epic_id TEXT NOT NULL,
      criterion_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (epic_id, criterion_id, child_id)
    )`,
  );
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS child_acknowledgements (
      card_id TEXT PRIMARY KEY NOT NULL,
      epic_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      acknowledged_at TEXT NOT NULL
    )`,
  );
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS story_deps (
      card_id TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (card_id, depends_on)
    )`,
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS story_deps_dep ON story_deps (depends_on)');
}

function ensureDeliveryState(sqlite: Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS delivery_policies (
      card_id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL,
      mode TEXT NOT NULL,
      required_checks TEXT NOT NULL,
      required_approvals INTEGER NOT NULL,
      manual_criteria TEXT NOT NULL,
      enrolled_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS evidence_records (
      id TEXT PRIMARY KEY NOT NULL,
      card_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      criterion_id TEXT,
      task_id TEXT,
      check_id TEXT,
      command TEXT,
      command_digest TEXT,
      exit_code INTEGER,
      result TEXT NOT NULL,
      producer TEXT NOT NULL,
      reviewer TEXT,
      rationale TEXT,
      scope_revision INTEGER NOT NULL,
      policy_version INTEGER NOT NULL,
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      input_coverage TEXT NOT NULL,
      artifact_path TEXT,
      artifact_sha256 TEXT,
      artifact_unavailable TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )`,
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS evidence_records_card ON evidence_records (card_id, criterion_id)');
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS provider_operations (
      id TEXT PRIMARY KEY NOT NULL,
      card_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      repo TEXT NOT NULL,
      project_id TEXT NOT NULL,
      marker TEXT NOT NULL,
      payload_revision INTEGER NOT NULL,
      payload TEXT NOT NULL,
      expected_head TEXT,
      expected_base TEXT,
      state TEXT NOT NULL,
      remote_id TEXT,
      remote_url TEXT,
      owner TEXT,
      error TEXT,
      next_action TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS provider_operations_card ON provider_operations (card_id, kind)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS provider_operations_state ON provider_operations (state)');
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY NOT NULL,
      card_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      mode TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      scope_revision INTEGER NOT NULL,
      input_fingerprint TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      head_sha TEXT,
      base_branch TEXT,
      merge_sha TEXT,
      merge_method TEXT,
      delivered_sha TEXT,
      provenance TEXT,
      state TEXT NOT NULL,
      refusal_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (card_id, attempt)
    )`,
  );
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS cleanup_tasks (
      id TEXT PRIMARY KEY NOT NULL,
      card_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      identity TEXT,
      detail TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (card_id, delivery_id, kind)
    )`,
  );

  const migrated = metaValue(sqlite, 'provider_ledger_migrated');
  if (migrated === null) {
    const hasIssueMap =
      sqlite
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='issue_map'")
        .get() != null;
    if (hasIssueMap) {
      const rows = sqlite
        .query('SELECT card_id, issue_number FROM issue_map')
        .all() as Array<{ card_id: string; issue_number: number }>;
      const insert = sqlite.query(
        `INSERT OR IGNORE INTO provider_operations
          (id, card_id, kind, provider, repo, project_id, marker, payload_revision, payload,
           state, remote_id, created_at, updated_at)
         VALUES (?, ?, 'issue-create', 'github', '', '', ?, 0, '{}', 'legacy-unobserved', ?, ?, ?)`,
      );
      const now = new Date().toISOString();
      for (const row of rows) {
        insert.run(
          `pop-legacy-${row.card_id}`,
          row.card_id,
          `deck:legacy:${row.card_id}`,
          String(row.issue_number),
          now,
          now,
        );
      }
    }
    sqlite
      .query("INSERT INTO deck_meta (key, value) VALUES ('provider_ledger_migrated', '1')")
      .run();
  }
}

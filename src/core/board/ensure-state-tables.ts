import type { Database } from 'bun:sqlite';
import { metaValue } from './state-meta.ts';

export function ensurePlanningState(sqlite: Database): void {
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

export function ensureDeliveryState(sqlite: Database): void {
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

export function ensureCapabilityState(sqlite: Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS capability_statements (
      id TEXT PRIMARY KEY NOT NULL,
      capability_id TEXT NOT NULL,
      statement_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      digest TEXT NOT NULL,
      source_card_id TEXT NOT NULL,
      source_criterion_id TEXT NOT NULL,
      source_scope_revision INTEGER NOT NULL,
      evidence_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      state TEXT NOT NULL,
      projection_version_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS capability_statements_current ON capability_statements (capability_id, statement_id, state)');
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS capability_previews (
      id TEXT PRIMARY KEY NOT NULL,
      batch_id TEXT NOT NULL,
      base_digest TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS capability_previews_batch ON capability_previews (batch_id, state)');
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS capability_versions (
      id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL,
      base_digest TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      preview_id TEXT NOT NULL,
      accepted_by TEXT NOT NULL,
      rationale TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS capability_versions_version ON capability_versions (version)');
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS capability_deltas (
      id TEXT PRIMARY KEY NOT NULL,
      batch_id TEXT NOT NULL,
      delta_id TEXT NOT NULL,
      op TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      statement_id TEXT NOT NULL,
      statement_digest TEXT,
      source_card_id TEXT NOT NULL,
      source_criterion_id TEXT NOT NULL,
      source_scope_revision INTEGER NOT NULL,
      evidence_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      preview_id TEXT NOT NULL,
      applied_version_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (delta_id)
    )`,
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS capability_deltas_preview ON capability_deltas (preview_id)');
}

import type { Database } from 'bun:sqlite';

export function ensureCollaborationState(sqlite: Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS task_state (
      task_id TEXT PRIMARY KEY NOT NULL,
      card_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      owner TEXT,
      assigned_at TEXT,
      updated_at TEXT NOT NULL
    )`,
  );
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS task_patches (
      command_id TEXT PRIMARY KEY NOT NULL,
      card_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      expected_revision INTEGER NOT NULL,
      payload_digest TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  );
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY NOT NULL,
      card_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      scope_revision INTEGER NOT NULL,
      checkpoint_revision INTEGER NOT NULL,
      remaining_work TEXT,
      evidence_ids TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    )`,
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS handoffs_card_state ON handoffs (card_id, state)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS task_state_card ON task_state (card_id)');

  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      project_path TEXT NOT NULL,
      path TEXT,
      branch TEXT NOT NULL,
      expected_head TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    )`,
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS workspaces_project_state ON workspaces (project_path, state)');

  const now = new Date().toISOString();
  sqlite
    .query(
      `INSERT OR IGNORE INTO task_state (task_id, card_id, revision, owner, assigned_at, updated_at)
       SELECT t.id, t.card_id, 1, NULL, NULL, ? FROM tasks t
       WHERE NOT EXISTS (SELECT 1 FROM task_state s WHERE s.task_id = t.id)`,
    )
    .run(now);
  sqlite
    .query(`DELETE FROM task_state WHERE task_id NOT IN (SELECT id FROM tasks)`)
    .run();
}


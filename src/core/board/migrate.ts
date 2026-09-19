import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { DeckError } from './errors.ts';
import { assertWriterAllowed } from './open-state.ts';
import { metaValue, setMetaValue, advanceWriterFloor } from './state-meta.ts';

export interface JournalEntry {
  name: string;
  sql: string;
  timestamp: number;
}

export type MigrationRunState = 'pending' | 'running' | 'completed';

export interface MigrationOutcome {
  applied: string[];
  backupPath: string | null;
}

export class MigrationError extends DeckError {}
export class MigrationInProgressError extends MigrationError {}

const MIGRATION_LOCK_KEY = 'migration_lock';
const LOCK_STALE_MS = 10 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function millisFrom(name: string): number {
  return Date.UTC(
    Number(name.slice(0, 4)),
    Number(name.slice(4, 6)) - 1,
    Number(name.slice(6, 8)),
    Number(name.slice(8, 10)),
    Number(name.slice(10, 12)),
    Number(name.slice(12, 14)),
  );
}

// The journal is the single migration authority: the drizzle/ folder when the
// source tree is present, the embedded copy otherwise. Both must list the same
// migrations in the same order.
export function loadJournal(): JournalEntry[] {
  const dir = join(import.meta.dir, '../../../drizzle');
  if (existsSync(dir)) {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'migration.sql')))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        sql: readFileSync(join(dir, name, 'migration.sql'), 'utf8'),
        timestamp: millisFrom(name),
      }));
  }
  // Lazy import keeps the generated module out of test module graphs that never
  // migrate from the filesystem.
  const embedded = require('./migrations.ts') as { migrationsJournal: JournalEntry[] };
  return embedded.migrationsJournal;
}

interface LockInfo {
  owner: string;
  pid: number;
  startedAt: number;
}

function readLock(sqlite: Database): LockInfo | null {
  const raw = metaValue(sqlite, MIGRATION_LOCK_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireMigrationLock(sqlite: Database): void {
  const existing = readLock(sqlite);
  if (existing !== null) {
    const stale = Date.now() - existing.startedAt > LOCK_STALE_MS;
    if (!stale && pidAlive(existing.pid)) {
      throw new MigrationInProgressError(
        `a migration by owner ${existing.owner} (pid ${existing.pid}) is in progress — retry once it completes`,
        { owner: existing.owner, pid: existing.pid },
      );
    }
    // Stale or dead-owner lock: the interrupted transaction rolled back, so
    // restarting is safe.
  }
  setMetaValue(sqlite, MIGRATION_LOCK_KEY, JSON.stringify({
    owner: `${process.pid}`,
    pid: process.pid,
    startedAt: Date.now(),
  } satisfies LockInfo));
}

function releaseMigrationLock(sqlite: Database): void {
  sqlite.query(`DELETE FROM deck_meta WHERE key = '${MIGRATION_LOCK_KEY}'`).run();
}

function ensureTrackingTable(sqlite: Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS migration_runs (
      migration TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    )`,
  );
}

// Databases migrated by the drizzle builtin migrator recorded progress in
// __drizzle_migrations (ordered by timestamp). Translate that once into
// migration_runs without claiming anything beyond what was actually applied.
function translateDrizzleHistory(sqlite: Database, journal: JournalEntry[]): void {
  const tracked = sqlite.query('SELECT COUNT(*) AS n FROM migration_runs').get() as { n: number };
  if (tracked.n > 0) return;
  const hasDrizzleTable =
    sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
      .get() != null;
  if (!hasDrizzleTable) return;
  const row = sqlite
    .query('SELECT MAX(created_at) AS last FROM __drizzle_migrations')
    .get() as { last: number | null };
  if (row.last === null) return;
  const insert = sqlite.query(
    `INSERT OR IGNORE INTO migration_runs (migration, state, started_at, completed_at)
     VALUES (?, 'completed', ?, ?)`,
  );
  const stamp = nowIso();
  for (const entry of journal) {
    if (entry.timestamp <= row.last) {
      insert.run(entry.name, stamp, stamp);
    }
  }
}

export function migrationStatus(
  sqlite: Database,
  options: { ensure?: boolean } = {},
): Array<{ name: string; state: MigrationRunState }> {
  if (options.ensure !== false) ensureTrackingTable(sqlite);
  const journal = loadJournal();
  translateDrizzleHistory(sqlite, journal);
  const rows = sqlite
    .query('SELECT migration, state FROM migration_runs')
    .all() as Array<{ migration: string; state: string }>;
  const byName = new Map(rows.map((row) => [row.migration, row.state]));
  // A persisted lock means an upgrade attempt started and never completed;
  // pending work under it is reported as running, not silently pending.
  const interrupted = readLock(sqlite) !== null;
  return journal.map((entry) => {
    const state = byName.get(entry.name);
    if (state === 'completed') return { name: entry.name, state: 'completed' as const };
    if (interrupted) return { name: entry.name, state: 'running' as const };
    return { name: entry.name, state: 'pending' as const };
  });
}

const ALTER_ADD = /^ALTER TABLE\s+[`"[]?([\w$]+)[`"\]]?\s+ADD COLUMN\s+[`"[]?([\w$]+)/i;

function columnExists(sqlite: Database, table: string, column: string): boolean {
  const cols = sqlite.query(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return cols.some((col) => col.name === column);
}

// Legacy databases already created part of the schema through runtime ensures.
// The migration stays the authority; applying it over such a database skips
// only statements whose effect is already present (columns), so repeated
// execution is idempotent without weakening the clean-database chain.
function applyStatements(sqlite: Database, sql: string): void {
  for (const raw of sql.split('--> statement-breakpoint')) {
    const statement = raw.trim();
    if (statement.length === 0) continue;
    const alter = statement.match(ALTER_ADD);
    if (alter !== null && columnExists(sqlite, alter[1]!, alter[2]!)) continue;
    sqlite.exec(statement);
  }
}

function verifyIntegrity(sqlite: Database): void {
  const fk = sqlite.query('PRAGMA foreign_key_check').all();
  if (fk.length > 0) {
    throw new MigrationError('foreign key check failed after migration', { violations: fk.length });
  }
  const integrity = sqlite.query('PRAGMA integrity_check').get() as { integrity_check: string };
  if (integrity.integrity_check !== 'ok') {
    throw new MigrationError(`integrity check failed: ${integrity.integrity_check}`, {});
  }
}

function verifiedBackup(dbPath: string): string {
  sqliteCheckpoint(dbPath);
  const backupPath = `${dbPath}.pre-migration`;
  copyFileSync(dbPath, backupPath);
  // Read-write open: a WAL-mode database refuses readonly access without its
  // sidecar files, and the truncated checkpoint already guarantees the main
  // file is complete on its own.
  const check = new Database(backupPath);
  try {
    const integrity = check.query('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrity.integrity_check !== 'ok') {
      throw new MigrationError(`pre-migration backup failed verification at ${backupPath}`, {
        backupPath,
      });
    }
  } finally {
    check.close();
  }
  for (const sidecar of ['-wal', '-shm']) {
    const path = `${backupPath}${sidecar}`;
    if (existsSync(path)) rmSync(path);
  }
  return backupPath;
}

function sqliteCheckpoint(dbPath: string): void {
  const handle = new Database(dbPath);
  try {
    handle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    handle.close();
  }
}

// One-time data translations that need host context (filesystem paths) live
// here, bound to the migration that owns them and guarded by their legacy
// flags so they run exactly once and never invent historical success.
function sweepLegacyActiveWork(sqlite: Database, projectPath: string): void {
  if (metaValue(sqlite, 'legacy_ownership_swept') !== null) return;
  const legacy = sqlite
    .query(
      `SELECT id FROM cards WHERE lane IN ('active', 'verify') ` +
        `AND id NOT IN (SELECT card_id FROM operations WHERE state IN ('active', 'recovery-required'))`,
    )
    .all() as Array<{ id: string }>;
  if (legacy.length > 0) {
    const checkout = realpathSync(projectPath);
    const now = nowIso();
    const insert = sqlite.query(
      `INSERT INTO operations (id, card_id, kind, owner, checkout, state, created_at, updated_at) ` +
        `VALUES (?, ?, 'start', 'legacy', ?, 'recovery-required', ?, ?)`,
    );
    for (const card of legacy) {
      insert.run(`op-legacy-${card.id}`, card.id, checkout, now, now);
    }
  }
  setMetaValue(sqlite, 'legacy_ownership_swept', '1');
}

function importLegacyProviderLedger(sqlite: Database): void {
  if (metaValue(sqlite, 'provider_ledger_migrated') !== null) return;
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
    const now = nowIso();
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
  setMetaValue(sqlite, 'provider_ledger_migrated', '1');
}

interface PostApplyStep {
  migration: string;
  run: (sqlite: Database, projectPath: string) => void;
}

const POST_APPLY_STEPS: PostApplyStep[] = [
  {
    migration: '20260919120000_control_plane_baseline',
    run: (sqlite, projectPath) => {
      const { ensureSpecTypes } = require('./types-registry.ts') as typeof import('./types-registry.ts');
      ensureSpecTypes(sqlite);
      const { ensureAgentHosts } = require('../projects/harness.ts') as typeof import('../projects/harness.ts');
      ensureAgentHosts(sqlite);
      sweepLegacyActiveWork(sqlite, projectPath);
      importLegacyProviderLedger(sqlite);
    },
  },
  {
    migration: '20260920120000_accepted_scope',
    run: (sqlite, projectPath) => {
      const { adoptLegacyScope } = require('./scope-adopt.ts') as typeof import('./scope-adopt.ts');
      adoptLegacyScope(sqlite, projectPath);
    },
  },
];

export function runMigrations(
  sqlite: Database,
  projectPath: string,
  options: { dbPath: string; journal?: JournalEntry[] },
): MigrationOutcome {
  assertWriterAllowed(sqlite);
  ensureTrackingTable(sqlite);
  const journal = options.journal ?? loadJournal();
  translateDrizzleHistory(sqlite, journal);

  const tracked = new Map(
    (sqlite
      .query('SELECT migration, state FROM migration_runs')
      .all() as Array<{ migration: string; state: string }>).map((row) => [row.migration, row.state]),
  );
  const pending = journal.filter((entry) => tracked.get(entry.name) !== 'completed');
  if (pending.length === 0) {
    // Everything already completed: make sure the floor reflects that (a
    // previous attempt may have completed migrations but died before the
    // floor write), without taking the lock or a backup.
    advanceWriterFloor(sqlite);
    return { applied: [], backupPath: null };
  }

  acquireMigrationLock(sqlite);
  let backupPath: string | null = null;
  const applied: string[] = [];
  try {
    verifyIntegrity(sqlite);
    backupPath = verifiedBackup(options.dbPath);
    const now = nowIso();
    for (const entry of pending) {
      // One immediate transaction per migration: DDL, seeds, integrity checks
      // and the completed marker commit together or not at all, so an
      // interrupted upgrade never advertises partial completion.
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        sqlite
          .query(
            `INSERT INTO migration_runs (migration, state, started_at, completed_at)
             VALUES (?, 'running', ?, NULL)
             ON CONFLICT(migration) DO UPDATE SET state = 'running', started_at = excluded.started_at, completed_at = NULL`,
          )
          .run(entry.name, nowIso());
        applyStatements(sqlite, entry.sql);
        for (const step of POST_APPLY_STEPS) {
          if (step.migration === entry.name) step.run(sqlite, projectPath);
        }
        verifyIntegrity(sqlite);
        sqlite
          .query(`UPDATE migration_runs SET state = 'completed', completed_at = ? WHERE migration = ?`)
          .run(nowIso(), entry.name);
        sqlite.exec('COMMIT');
        applied.push(entry.name);
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw new MigrationError(
          `migration ${entry.name} failed and was rolled back — nothing was partially applied; ` +
            `fix the cause and reopen to retry (backup at ${backupPath})`,
          { migration: entry.name, backupPath, cause: String(error) },
        );
      }
    }
    // The floor rises only after every pending migration completed and the
    // database verified clean, so older binaries refuse the upgraded store.
    advanceWriterFloor(sqlite);
    releaseMigrationLock(sqlite);
    return { applied, backupPath };
  } catch (error) {
    releaseMigrationLock(sqlite);
    throw error;
  }
}

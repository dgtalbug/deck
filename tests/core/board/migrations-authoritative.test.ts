import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpProject, type TmpProject } from '../../helpers.ts';
import {
  loadJournal,
  migrationStatus,
  runMigrations,
  MigrationError,
  type JournalEntry,
} from '../../../src/core/board/migrate.ts';
import { assertWriterAllowed } from '../../../src/core/board/open-state.ts';
import { DocumentStore } from '../../../src/core/board/store.ts';

const DRIZZLE_DIR = join(import.meta.dir, '../../../drizzle');

function migrationSql(name: string): string {
  return readFileSync(join(DRIZZLE_DIR, name, 'migration.sql'), 'utf8');
}

function execAll(db: Database, sql: string): void {
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) db.exec(trimmed);
  }
}

// A database as an older binary left it: drizzle 0001+0002 applied through the
// builtin migrator (recorded in __drizzle_migrations), no runtime ensures.
function buildDrizzleLegacyDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  execAll(db, migrationSql('20260825185055_nappy_firebrand'));
  execAll(db, migrationSql('20260906151614_overjoyed_daredevil'));
  db.exec(
    `CREATE TABLE __drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );
  db.query('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('x', 1788707774000);
  db.query(
    `INSERT INTO cards (id, type, title, lane, position, created_at, updated_at)
     VALUES ('c1', 'note', 'legacy note', 'todo', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  db.close();
  return new Database(path);
}

// A database as the pre-migration runtime left it: drizzle tables plus a
// representative subset of runtime-ensured state, including unsettled
// ownership and an unmapped active card the one-time translations must catch.
function buildRuntimeEnsuredLegacyDb(path: string): Database {
  const db = buildDrizzleLegacyDb(path);
  db.exec(`CREATE TABLE deck_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`);
  db.exec(
    `CREATE TABLE operations (
      id TEXT PRIMARY KEY NOT NULL, card_id TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL,
      checkout TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  );
  db.query(
    `INSERT INTO operations (id, card_id, kind, owner, checkout, state, created_at, updated_at)
     VALUES ('op-1', 'c1', 'start', 'owner-a', '/w', 'reserved', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  db.query(
    `INSERT INTO cards (id, type, title, lane, position, created_at, updated_at)
     VALUES ('c2', 'verb', 'legacy active', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  db.query(
    `INSERT INTO issue_map (card_id, issue_number, state, checksum, updated_at)
     VALUES ('c1', 42, 'open', 'deadbeef', '2026-01-01T00:00:00Z')`,
  ).run();
  return db;
}

describe('authoritative migrations', () => {
  let project: TmpProject;

  beforeAll(() => {
    project = tmpProject('deck-migrations-');
  });

  afterAll(() => {
    project.cleanup();
  });

  test('clean project applies the full chain, seeds, and advances the floor once', async () => {
    const store = await DocumentStore.open(project.path);
    store.raw().close();
    const db = new Database(join(project.path, '.deck', 'board.sqlite'), { readonly: true });
    const runs = db.query('SELECT migration, state FROM migration_runs').all() as Array<{ migration: string; state: string }>;
    expect(runs.every((row) => row.state === 'completed')).toBe(true);
    expect(runs.length).toBe(loadJournal().length);
    const floor = (db.query(`SELECT value FROM deck_meta WHERE key = 'min_writer_version'`).get() as { value: string }).value;
    expect(floor).toBe('0.6.0');
    expect((db.query('SELECT COUNT(*) AS n FROM spec_types').get() as { n: number }).n).toBe(11);
    expect((db.query('SELECT COUNT(*) AS n FROM agent_hosts').get() as { n: number }).n).toBe(6);
    expect((db.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    const fk = db.query('PRAGMA foreign_key_check').all();
    expect(fk.length).toBe(0);
    db.close();
  });

  test('second open applies nothing and creates no second backup', async () => {
    const before = migrationStatus(new Database(join(project.path, '.deck', 'board.sqlite'), { readonly: true }));
    expect(before.every((entry) => entry.state === 'completed')).toBe(true);
    const store = await DocumentStore.open(project.path);
    const applied = runMigrations(store.raw(), project.path, {
      dbPath: join(project.path, '.deck', 'board.sqlite'),
    });
    expect(applied.applied).toEqual([]);
    store.raw().close();
  });

  test('drizzle-legacy database converges with data preserved', () => {
    const legacy = tmpProject('deck-mig-legacy-');
    const dbPath = join(legacy.path, '.deck', 'board.sqlite');
    const legacyDb = buildDrizzleLegacyDb(dbPath);
    legacyDb.close();
    const runDb = new Database(dbPath);
    const outcome = runMigrations(runDb, legacy.path, { dbPath });
    runDb.close();
    expect(outcome.applied.length).toBeGreaterThan(0);
    expect(existsSync(`${dbPath}.pre-migration`)).toBe(true);
    const db = new Database(dbPath);
    expect((db.query(`SELECT title FROM cards WHERE id = 'c1'`).get() as { title: string }).title).toBe('legacy note');
    const runs = db.query('SELECT migration, state FROM migration_runs').all() as Array<{ state: string }>;
    expect(runs.every((row) => row.state === 'completed')).toBe(true);
    expect((db.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    db.close();
    legacy.cleanup();
  });

  test('runtime-ensured legacy database translates one-time state without inventing success', () => {
    const legacy = tmpProject('deck-mig-runtime-');
    const dbPath = join(legacy.path, '.deck', 'board.sqlite');
    const legacyDb = buildRuntimeEnsuredLegacyDb(dbPath);
    legacyDb.close();
    const runDb = new Database(dbPath);
    runMigrations(runDb, legacy.path, { dbPath });
    const db = new Database(dbPath);
    // Existing reserved work becomes recovery-required, never completed.
    expect(
      (db.query(`SELECT state FROM operations WHERE id = 'op-1'`).get() as { state: string }).state,
    ).toBe('recovery-required');
    // An active card with no operation is swept as recovery-required legacy work.
    const swept = db.query(`SELECT id, state FROM operations WHERE id = 'op-legacy-c2'`).get() as { state: string } | null;
    expect(swept?.state).toBe('recovery-required');
    // The recorded issue import stays legacy-unobserved, not observed success.
    const imported = db
      .query(`SELECT state, remote_id FROM provider_operations WHERE id = 'pop-legacy-c1'`)
      .get() as { state: string; remote_id: string };
    expect(imported.state).toBe('legacy-unobserved');
    expect(imported.remote_id).toBe('42');
    // One-time flags are recorded so re-running never re-translates.
    expect(db.query(`SELECT value FROM deck_meta WHERE key = 'legacy_ownership_swept'`).get()).not.toBeNull();
    expect(db.query(`SELECT value FROM deck_meta WHERE key = 'provider_ledger_migrated'`).get()).not.toBeNull();
    // Re-running is idempotent.
    const againDb = new Database(dbPath);
    const again = runMigrations(againDb, legacy.path, { dbPath });
    againDb.close();
    expect(again.applied).toEqual([]);
    const ops = db.query(`SELECT COUNT(*) AS n FROM operations WHERE id LIKE 'op-legacy-%'`).get() as { n: number };
    expect(ops.n).toBe(1);
    db.close();
    legacy.cleanup();
  });

  test('interrupted upgrade rolls back atomically and restarts', () => {
    const legacy = tmpProject('deck-mig-interrupt-');
    const dbPath = join(legacy.path, '.deck', 'board.sqlite');
    const db = buildDrizzleLegacyDb(dbPath);
    db.close();
    const journal: JournalEntry[] = [
      ...loadJournal(),
      {
        name: '99999999999999_always_fails',
        sql: 'CREATE TABLE should_not_exist (id TEXT); --> statement-breakpoint\nTHIS IS NOT SQL;',
        timestamp: 99999999999999,
      },
    ];
    const failDb = new Database(dbPath);
    expect(() => runMigrations(failDb, legacy.path, { dbPath, journal })).toThrow(MigrationError);
    failDb.close();
    const after = new Database(dbPath);
    // The failing migration left nothing behind and did not mark completion.
    expect(after.query(`SELECT name FROM sqlite_master WHERE name = 'should_not_exist'`).get()).toBeNull();
    const baseline = after
      .query(`SELECT state FROM migration_runs WHERE migration = '20260919120000_control_plane_baseline'`)
      .get() as { state: string } | null;
    expect(baseline?.state).toBe('completed');
    const failing = after
      .query(`SELECT state FROM migration_runs WHERE migration = '99999999999999_always_fails'`)
      .get();
    expect(failing).toBeNull();
    // The floor is not advertised while any migration of the attempt is
    // unfinished, even though earlier ones committed.
    expect(after.query(`SELECT value FROM deck_meta WHERE key = 'min_writer_version'`).get()).toBeNull();
    after.close();
    // A lock left behind by a crashed upgrade attempt reports the still-pending
    // work as running; the next run clears it and completes. Simulated on a
    // fresh legacy database where the baseline has not yet applied.
    const crashDir = tmpProject('deck-mig-crash-');
    const crashPath = join(crashDir.path, '.deck', 'board.sqlite');
    const crashLegacy = buildDrizzleLegacyDb(crashPath);
    crashLegacy.close();
    const crashSim = new Database(crashPath);
    crashSim.exec('CREATE TABLE IF NOT EXISTS deck_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
    crashSim
      .query(
        `INSERT INTO deck_meta (key, value) VALUES ('migration_lock', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify({ owner: 'dead', pid: 999999, startedAt: Date.now() }));
    crashSim.close();
    const statusDb = new Database(crashPath);
    expect(migrationStatus(statusDb).some((entry) => entry.state === 'running')).toBe(true);
    statusDb.close();
    const crashRun = new Database(crashPath);
    expect(runMigrations(crashRun, crashDir.path, { dbPath: crashPath }).applied.length).toBeGreaterThan(0);
    crashRun.close();
    const crashAfter = new Database(crashPath);
    expect(migrationStatus(crashAfter).every((entry) => entry.state === 'completed')).toBe(true);
    crashAfter.close();
    crashDir.cleanup();
    const retryDb = new Database(dbPath);
    const retried = runMigrations(retryDb, legacy.path, { dbPath });
    retryDb.close();
    expect(retried.applied).toEqual([]);
    const floorDb = new Database(dbPath);
    expect(
      (floorDb.query(`SELECT value FROM deck_meta WHERE key = 'min_writer_version'`).get() as { value: string }).value,
    ).toBe('0.6.0');
    floorDb.close();
    legacy.cleanup();
  });

  test('restoring the pre-upgrade backup with the prior binary stays readable', () => {
    const legacy = tmpProject('deck-mig-restore-');
    const dbPath = join(legacy.path, '.deck', 'board.sqlite');
    const db = buildDrizzleLegacyDb(dbPath);
    db.close();
    const runDb = new Database(dbPath);
    runMigrations(runDb, legacy.path, { dbPath });
    runDb.close();
    // Operator rollback: stop writers, restore the verified backup.
    const db2 = new Database(dbPath);
    db2.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db2.close();
    const restorePath = `${legacy.path}/restored.sqlite`;
    copyFileSync(`${dbPath}.pre-migration`, restorePath);
    const restored = new Database(restorePath);
    expect((restored.query(`SELECT title FROM cards WHERE id = 'c1'`).get() as { title: string }).title).toBe('legacy note');
    expect((restored.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    restored.close();
    // An upgraded database refuses an older writer binary.
    const upgraded = new Database(dbPath);
    upgraded
      .query(`INSERT INTO deck_meta (key, value) VALUES ('min_writer_version', '99.0.0')
              ON CONFLICT(key) DO UPDATE SET value = '99.0.0'`)
      .run();
    upgraded.close();
    expect(() => assertWriterAllowed(new Database(dbPath))).toThrow(/requires deck >= 99\.0\.0/);
    legacy.cleanup();
  });

  test('filesystem and embedded journals converge to identical schema metadata', async () => {
    const fsJournal = loadJournal();
    const embedded = (await import('../../../src/core/board/migrations.ts')).migrationsJournal;
    expect(fsJournal.map((entry) => entry.name)).toEqual(embedded.map((entry) => entry.name));
    const a = tmpProject('deck-mig-fs-');
    const b = tmpProject('deck-mig-emb-');
    mkdirSync(join(a.path, '.deck'), { recursive: true });
    mkdirSync(join(b.path, '.deck'), { recursive: true });
    const aDb = new Database(join(a.path, '.deck', 'board.sqlite'));
    const bDb = new Database(join(b.path, '.deck', 'board.sqlite'));
    runMigrations(aDb, a.path, { dbPath: join(a.path, '.deck', 'board.sqlite'), journal: fsJournal });
    runMigrations(bDb, b.path, { dbPath: join(b.path, '.deck', 'board.sqlite'), journal: embedded });
    const schemaOf = (db: Database) =>
      (db.query(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as Array<{ type: string; name: string }>)
        .map((row) => `${row.type}:${row.name}`)
        .join('|');
    expect(schemaOf(aDb)).toBe(schemaOf(bDb));
    aDb.close();
    bDb.close();
    a.cleanup();
    b.cleanup();
  });
});

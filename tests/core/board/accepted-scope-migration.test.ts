import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpProject, type TmpProject } from '../../helpers.ts';
import { loadJournal, runMigrations } from '../../../src/core/board/migrate.ts';

const CLEANUPS: Array<() => void> = [];

afterEach(() => {
  while (CLEANUPS.length > 0) CLEANUPS.pop()!();
});

const ACCEPTED_SCOPE = '20260920120000_accepted_scope';
const TS = '2026-01-01T00:00:00Z';

function openDb(path: string): Database {
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

// A database on the pre-accepted-scope chain: the fixture rows the migration
// must audit, classify and (only where safe) adopt.
function legacyDb(name: string): { project: TmpProject; db: Database; path: string } {
  const project = tmpProject('accepted-scope-mig-');
  CLEANUPS.push(project.cleanup);
  const path = join(project.path, `${name}.sqlite`);
  const db = openDb(path);
  runMigrations(db, project.path, {
    dbPath: path,
    journal: loadJournal().filter((entry) => entry.name !== ACCEPTED_SCOPE),
  });
  return { project, db, path };
}

function insertCard(
  db: Database,
  id: string,
  overrides: Partial<Record<'type' | 'lane' | 'verb' | 'spec_path' | 'scope_revision' | 'completed_at', string | number | null>> = {},
): void {
  db.query(
    `INSERT INTO cards (id, type, title, verb, lane, position, spec_path, scope_revision, completed_at, research, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, '{"codebaseFindings":["f"]}', ?, ?)`,
  ).run(
    id,
    overrides.type ?? 'verb',
    `title ${id}`,
    overrides.verb ?? 'feat',
    overrides.lane ?? 'groomed',
    overrides.spec_path ?? null,
    overrides.scope_revision ?? null,
    overrides.completed_at ?? null,
    TS,
    TS,
  );
}

function insertTask(db: Database, cardId: string, idx: number, id: string, title: string, done = false): void {
  db.query(`INSERT INTO tasks (card_id, idx, id, title, done) VALUES (?, ?, ?, ?, ?)`).run(
    cardId,
    idx,
    id,
    title,
    done ? 1 : 0,
  );
}

function insertState(db: Database, taskId: string, cardId: string, owner = 'agent-1'): void {
  db.query(
    `INSERT INTO task_state (task_id, card_id, revision, owner, assigned_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)`,
  ).run(taskId, cardId, owner, TS, TS);
}

function insertCriterion(db: Database, cardId: string, id: string, title: string, state = 'active'): void {
  db.query(
    `INSERT INTO scope_items (card_id, id, kind, title, state, first_revision, last_revision) VALUES (?, ?, 'criterion', ?, ?, 1, 1)`,
  ).run(cardId, id, title, state);
}

function insertSpec(db: Database, cardId: string, checksum = 'chk-a'): void {
  db.query(
    `INSERT INTO specs (card_id, version, markdown, checksum, created_at) VALUES (?, 1, '# spec', ?, ?)`,
  ).run(cardId, checksum, TS);
}

function rows(db: Database, sql: string): Array<Record<string, unknown>> {
  return db.query(sql).all() as Array<Record<string, unknown>>;
}

describe('accepted scope migration convergence', () => {
  test('clean database applies the chain and exposes composite task identity', () => {
    const project = tmpProject('accepted-scope-clean-');
    CLEANUPS.push(project.cleanup);
    const path = join(project.path, 'clean.sqlite');
    const db = openDb(path);
    const outcome = runMigrations(db, project.path, { dbPath: path });

    expect(outcome.applied).toContain(ACCEPTED_SCOPE);
    expect(rows(db, 'SELECT * FROM spec_revisions')).toEqual([]);
    expect(rows(db, 'SELECT * FROM scope_quarantine')).toEqual([]);

    db.query(
      `INSERT INTO task_state (task_id, card_id, revision, owner, assigned_at, updated_at) VALUES ('t-same', 'c-a', 1, NULL, NULL, ?)`,
    ).run(TS);
    db.query(
      `INSERT INTO task_state (task_id, card_id, revision, owner, assigned_at, updated_at) VALUES ('t-same', 'c-b', 1, NULL, NULL, ?)`,
    ).run(TS);
    expect(rows(db, 'SELECT COUNT(*) AS n FROM task_state')[0]).toEqual({ n: 2 });
    expect(() =>
      db.query(
        `INSERT INTO task_state (task_id, card_id, revision, owner, assigned_at, updated_at) VALUES ('t-same', 'c-a', 2, NULL, NULL, ?)`,
      ).run(TS),
    ).toThrow(/UNIQUE/);
    db.close();
  });

  test('legacy safe card is adopted with snapshot, counter continuity and projection links', () => {
    const { project, db, path } = legacyDb('adopt');
    const specDir = join(project.path, '.deck/specs/tasks/feat-c-adopt');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, 'spec.md'),
      ['## Requirements', '', '### ADDED: first requirement', 'body one', '', '### MODIFIED: second requirement', 'body two', '', '## Blast radius', '', '- x', ''].join('\n'),
    );
    insertCard(db, 'c-adopt', { spec_path: '.deck/specs/tasks/feat-c-adopt/', scope_revision: 2 });
    insertTask(db, 'c-adopt', 0, 't-aaa', 'write code');
    insertTask(db, 'c-adopt', 1, 't-bbb', 'write tests');
    insertState(db, 't-aaa', 'c-adopt');
    insertCriterion(db, 'c-adopt', 'c-abc12345', 'first requirement');
    insertSpec(db, 'c-adopt', 'chk-a');
    db.query(
      `INSERT INTO issue_map (card_id, issue_number, state, checksum, updated_at) VALUES ('c-adopt', 11, 'open', 'chk-a', ?)`,
    ).run(TS);
    db.close();

    const reopened = openDb(path);
    const outcome = runMigrations(reopened, project.path, { dbPath: path });
    expect(outcome.applied).toEqual([ACCEPTED_SCOPE]);

    const revisions = rows(reopened, 'SELECT * FROM spec_revisions');
    expect(revisions.length).toBe(1);
    const revision = revisions[0]!;
    expect(revision['card_id']).toBe('c-adopt');
    expect(revision['revision']).toBe(2);
    expect(revision['actor']).toBe('migration-audit');
    expect(revision['basis_revision']).toBe(null);
    const ops = JSON.parse(revision['operations'] as string);
    expect(ops).toEqual([{ kind: 'adopt', source: 'migration-audit', requirements: 'parsed' }]);

    expect(rows(reopened, "SELECT req_id, position, title, body FROM spec_requirements ORDER BY position")).toEqual([
      { req_id: expect.stringMatching(/^r-/), position: 0, title: 'first requirement', body: 'body one' },
      { req_id: expect.stringMatching(/^r-/), position: 1, title: 'second requirement', body: 'body two' },
    ]);
    expect(rows(reopened, 'SELECT criterion_id, title, state FROM spec_criteria')).toEqual([
      { criterion_id: 'c-abc12345', title: 'first requirement', state: 'active' },
    ]);
    expect(rows(reopened, 'SELECT task_id, position, title, state FROM spec_plan_items ORDER BY position')).toEqual([
      { task_id: 't-aaa', position: 0, title: 'write code', state: 'active' },
      { task_id: 't-bbb', position: 1, title: 'write tests', state: 'active' },
    ]);
    expect(rows(reopened, 'SELECT scope_revision FROM cards WHERE id = \'c-adopt\'')[0]).toEqual({ scope_revision: 2 });
    expect(rows(reopened, 'SELECT scope_revision FROM specs WHERE card_id = \'c-adopt\'')[0]).toEqual({ scope_revision: 2 });
    expect(rows(reopened, 'SELECT scope_revision FROM issue_map WHERE card_id = \'c-adopt\'')[0]).toEqual({ scope_revision: 2 });
    expect(rows(reopened, 'SELECT revision, owner FROM task_state')).toEqual([{ revision: 1, owner: 'agent-1' }]);

    const again = runMigrations(reopened, project.path, { dbPath: path });
    expect(again.applied).toEqual([]);
    reopened.close();
  });

  test('issue link stays unclaimed when the published checksum is stale', () => {
    const { project, db, path } = legacyDb('stale-issue');
    insertCard(db, 'c-stale', { scope_revision: 1 });
    insertTask(db, 'c-stale', 0, 't-s1', 'work');
    insertSpec(db, 'c-stale', 'chk-new');
    db.query(
      `INSERT INTO issue_map (card_id, issue_number, state, checksum, updated_at) VALUES ('c-stale', 12, 'open', 'chk-old', ?)`,
    ).run(TS);
    db.close();

    const reopened = openDb(path);
    runMigrations(reopened, project.path, { dbPath: path });
    expect(rows(reopened, 'SELECT scope_revision FROM issue_map WHERE card_id = \'c-stale\'')[0]).toEqual({ scope_revision: null });
    reopened.close();
  });

  test('ambiguous and historical cards stay unadopted but readable, diagnostics recorded', () => {
    const { project, db, path } = legacyDb('quarantine');
    insertCard(db, 'c-quar');
    insertTask(db, 'c-quar', 0, 't-q1', 'work a');
    insertTask(db, 'c-quar', 1, 't-q2', 'work b');
    insertState(db, 't-q1', 'c-quar');
    insertState(db, 't-ghost', 'c-quar');
    insertSpec(db, 'c-quar');

    insertCard(db, 'c-done', { lane: 'done', completed_at: TS });
    insertTask(db, 'c-done', 0, 't-d1', 'shipped', true);
    insertSpec(db, 'c-done');

    db.close();

    const reopened = openDb(path);
    runMigrations(reopened, project.path, { dbPath: path });

    const quarantine = rows(reopened, 'SELECT card_id, kind FROM scope_quarantine ORDER BY card_id');
    expect(quarantine).toEqual([{ card_id: 'c-quar', kind: 'orphaned-task-state' }]);
    expect(rows(reopened, 'SELECT card_id FROM spec_revisions')).toEqual([]);
    expect(rows(reopened, "SELECT scope_revision FROM specs WHERE card_id = 'c-quar' OR card_id = 'c-done'")).toEqual([
      { scope_revision: null },
      { scope_revision: null },
    ]);
    expect(rows(reopened, 'SELECT COUNT(*) AS n FROM tasks')[0]).toEqual({ n: 3 });
    expect(rows(reopened, 'SELECT COUNT(*) AS n FROM specs')[0]).toEqual({ n: 2 });
    expect(rows(reopened, 'SELECT COUNT(*) AS n FROM task_state')[0]).toEqual({ n: 2 });
    const fk = reopened.query('PRAGMA foreign_key_check').all();
    const integrity = reopened.query('PRAGMA integrity_check').get() as { integrity_check: string };
    expect(fk).toEqual([]);
    expect(integrity.integrity_check).toBe('ok');
    reopened.close();
  });

  test('tweak cards adopt with a plan item and no requirements', () => {
    const { project, db, path } = legacyDb('tweak-adopt');
    insertCard(db, 'c-tweak', { type: 'tweak', lane: 'active' });
    insertTask(db, 'c-tweak', 0, 't-twk', 'tweak work');
    insertState(db, 't-twk', 'c-tweak');
    db.close();

    const reopened = openDb(path);
    runMigrations(reopened, project.path, { dbPath: path });
    const revision = rows(reopened, 'SELECT revision, actor FROM spec_revisions')[0]!;
    expect(revision['revision']).toBe(1);
    expect(revision['actor']).toBe('migration-audit');
    const ops = JSON.parse(rows(reopened, 'SELECT operations FROM spec_revisions')[0]!['operations'] as string);
    expect(ops).toEqual([{ kind: 'adopt', source: 'migration-audit', requirements: 'none' }]);
    expect(rows(reopened, 'SELECT task_id FROM spec_plan_items')).toEqual([{ task_id: 't-twk' }]);
    expect(rows(reopened, 'SELECT COUNT(*) AS n FROM spec_requirements')[0]).toEqual({ n: 0 });
    reopened.close();
  });

  test('legacy classifications: accepted, unclassified and quarantined stay readable without invented acceptance', async () => {
    const { project, db, path } = legacyDb('classes');
    insertCard(db, 'c-ok', { scope_revision: 1 });
    insertTask(db, 'c-ok', 0, 't-ok1', 'work');
    insertCriterion(db, 'c-ok', 'c-okcrit1', 'criterion');

    insertCard(db, 'c-hist', { lane: 'done', completed_at: TS });
    insertTask(db, 'c-hist', 0, 't-h1', 'shipped', true);
    insertSpec(db, 'c-hist');
    db.query(
      `INSERT INTO issue_map (card_id, issue_number, state, checksum, updated_at) VALUES ('c-hist', 21, 'closed', 'chk-a', ?)`,
    ).run(TS);

    insertCard(db, 'c-quar');
    insertTask(db, 'c-quar', 0, 't-q1', 'work');
    insertState(db, 't-orphan', 'c-quar');
    insertSpec(db, 'c-quar');
    db.close();

    const reopened = openDb(path);
    runMigrations(reopened, project.path, { dbPath: path });
    const { drizzle } = await import('drizzle-orm/bun-sqlite');
    const { scopeClassification, currentAcceptedSnapshot, scopeCriteria } = await import(
      '../../../src/core/board/accepted-scope.ts'
    );
    const db2 = drizzle({ client: reopened });

    expect(scopeClassification(db2, 'c-ok')).toBe('accepted');
    expect(scopeClassification(db2, 'c-hist')).toBe('unclassified');
    expect(scopeClassification(db2, 'c-quar')).toBe('quarantined');

    // historical completion with issue + spec evidence stays unclassified —
    // acceptance never inferred from lane, markdown or issue state
    expect(currentAcceptedSnapshot(db2, 'c-hist')).toBeNull();
    expect(currentAcceptedSnapshot(db2, 'c-quar')).toBeNull();
    expect(rows(reopened, "SELECT state FROM issue_map WHERE card_id = 'c-hist'")).toEqual([{ state: 'closed' }]);

    // legacy rows remain readable for the unclassified and quarantined cards
    expect(rows(reopened, "SELECT id FROM tasks WHERE card_id = 'c-hist'")).toEqual([{ id: 't-h1' }]);
    expect(rows(reopened, "SELECT id FROM tasks WHERE card_id = 'c-quar'")).toEqual([{ id: 't-q1' }]);
    expect(rows(reopened, "SELECT markdown FROM specs WHERE card_id = 'c-quar'")).toEqual([{ markdown: '# spec' }]);

    // unclassified criteria still read through the legacy fallback
    insertCriterion(reopened, 'c-hist', 'unclassified', 'legacy criterion', 'active');
    expect(scopeCriteria(db2, 'c-hist')).toEqual([{ id: 'unclassified', title: 'legacy criterion', state: 'active' }]);
    reopened.close();
  });
});

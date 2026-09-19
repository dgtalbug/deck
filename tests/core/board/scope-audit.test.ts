import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpProject } from '../../helpers.ts';
import { loadJournal, runMigrations } from '../../../src/core/board/migrate.ts';
import { auditLegacyScope } from '../../../src/core/board/scope-audit.ts';

const CLEANUPS: Array<() => void> = [];

afterEach(() => {
  while (CLEANUPS.length > 0) CLEANUPS.pop()!();
});

function migratedDb(name: string): { db: Database; path: string } {
  const project = tmpProject('scope-audit-');
  CLEANUPS.push(project.cleanup);
  const path = join(project.path, `${name}.sqlite`);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  runMigrations(db, project.path, { dbPath: path, journal: loadJournal().filter((entry) => !entry.name.startsWith('20260920120000')) });
  return { db, path };
}

const TS = '2026-01-01T00:00:00Z';

function insertCard(
  db: Database,
  id: string,
  overrides: Partial<Record<'type' | 'lane' | 'research' | 'completed_at' | 'verb', string | null>> = {},
): void {
  db.query(
    `INSERT INTO cards (id, type, title, verb, lane, position, research, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.type ?? 'verb',
    `title ${id}`,
    overrides.verb ?? 'feat',
    overrides.lane ?? 'groomed',
    1,
    overrides.research !== undefined ? overrides.research : '{"codebaseFindings":["f"]}',
    overrides.completed_at ?? null,
    TS,
    TS,
  );
}

function insertTask(db: Database, cardId: string, idx: number, id: string, title: string, done = false): void {
  db.query(
    `INSERT INTO tasks (card_id, idx, id, title, done) VALUES (?, ?, ?, ?, ?)`,
  ).run(cardId, idx, id, title, done ? 1 : 0);
}

function insertState(db: Database, taskId: string, cardId: string): void {
  db.query(
    `INSERT INTO task_state (task_id, card_id, revision, owner, assigned_at, updated_at) VALUES (?, ?, 1, NULL, NULL, ?)`,
  ).run(taskId, cardId, TS);
}

function insertSpec(db: Database, cardId: string): void {
  db.query(
    `INSERT INTO specs (card_id, version, markdown, checksum, created_at) VALUES (?, 1, '# spec', 'chk-1', ?)`,
  ).run(cardId, TS);
}

function insertCriterion(db: Database, cardId: string, id: string, state = 'active'): void {
  db.query(
    `INSERT INTO scope_items (card_id, id, kind, title, state, first_revision, last_revision) VALUES (?, ?, 'criterion', 'criterion ${id}', ?, 1, 1)`,
  ).run(cardId, id, state);
}

function auditOf(report: ReturnType<typeof auditLegacyScope>, cardId: string) {
  return report.cards.find((entry) => entry.cardId === cardId);
}

describe('legacy scope audit classification', () => {
  test('clean groomed card with matching state classifies safe', () => {
    const { db } = migratedDb('safe');
    insertCard(db, 'c-safe');
    insertTask(db, 'c-safe', 0, 't-a', 'write code');
    insertTask(db, 'c-safe', 1, 't-b', 'write tests');
    insertState(db, 't-a', 'c-safe');
    insertState(db, 't-b', 'c-safe');
    insertCriterion(db, 'c-safe', 'c-abc');

    const report = auditLegacyScope(db);
    const audit = auditOf(report, 'c-safe');
    expect(audit?.cardClass).toBe('safe');
    expect(audit?.diagnostics).toEqual([]);
    expect(report.diagnostics).toEqual([]);
  });

  test('duplicate task titles with distinct ids stay safe', () => {
    const { db } = migratedDb('dup-titles');
    insertCard(db, 'c-dup');
    insertTask(db, 'c-dup', 0, 't-1', 'add test');
    insertTask(db, 'c-dup', 1, 't-2', 'add test');

    const report = auditLegacyScope(db);
    expect(auditOf(report, 'c-dup')?.cardClass).toBe('safe');
  });

  test('same task id on two cards quarantines both', () => {
    const { db } = migratedDb('cross-card');
    insertCard(db, 'c-one');
    insertCard(db, 'c-two');
    insertTask(db, 'c-one', 0, 't-shared', 'shared work');
    insertTask(db, 'c-two', 0, 't-shared', 'other work');

    const report = auditLegacyScope(db);
    expect(auditOf(report, 'c-one')?.cardClass).toBe('quarantined');
    expect(auditOf(report, 'c-two')?.cardClass).toBe('quarantined');
    const kinds = report.diagnostics.map((diagnostic) => diagnostic.kind);
    expect(kinds).toContain('cross-card-task-id');
  });

  test('task id repeated within one card quarantines as duplicate-task-id', () => {
    const { db } = migratedDb('dup-id');
    insertCard(db, 'c-dupid');
    insertTask(db, 'c-dupid', 0, 't-same', 'first');
    insertTask(db, 'c-dupid', 1, 't-same', 'second');

    const report = auditLegacyScope(db);
    expect(auditOf(report, 'c-dupid')?.cardClass).toBe('quarantined');
    expect(report.diagnostics.some((diagnostic) => diagnostic.kind === 'duplicate-task-id')).toBe(true);
  });

  test('orphaned task_state rows quarantine without inventing progress mapping', () => {
    const { db } = migratedDb('orphan');
    insertCard(db, 'c-owner');
    insertTask(db, 'c-owner', 0, 't-real', 'real work');
    insertState(db, 't-real', 'c-owner');
    insertState(db, 't-ghost', 'c-owner');

    const report = auditLegacyScope(db);
    expect(auditOf(report, 'c-owner')?.cardClass).toBe('quarantined');
    const orphan = report.diagnostics.find((diagnostic) => diagnostic.kind === 'orphaned-task-state');
    expect(orphan?.detail).toEqual({ taskId: 't-ghost', note: 'state row references a task this card does not own' });
  });

  test('state row claiming another card task quarantines both sides', () => {
    const { db } = migratedDb('mismatch');
    insertCard(db, 'c-hold');
    insertCard(db, 'c-real');
    insertTask(db, 'c-real', 0, 't-mis', 'work');
    insertState(db, 't-mis', 'c-hold');

    const report = auditLegacyScope(db);
    expect(auditOf(report, 'c-real')?.cardClass).toBe('quarantined');
    expect(auditOf(report, 'c-hold')?.cardClass).toBe('quarantined');
  });

  test('rendered specs without reconstructable scope quarantine as spec-without-scope', () => {
    const { db } = migratedDb('spec-only');
    insertCard(db, 'c-spec', { research: null });
    insertSpec(db, 'c-spec');

    const report = auditLegacyScope(db);
    expect(auditOf(report, 'c-spec')?.cardClass).toBe('quarantined');
    expect(report.diagnostics.some((diagnostic) => diagnostic.kind === 'spec-without-scope')).toBe(true);
  });

  test('historical done card classifies unclassified even with issue and spec state present', () => {
    const { db } = migratedDb('done');
    insertCard(db, 'c-done', { lane: 'done', completed_at: TS });
    insertTask(db, 'c-done', 0, 't-d1', 'shipped it', true);
    insertSpec(db, 'c-done');
    insertCriterion(db, 'c-done', 'c-def');
    db.query(
      `INSERT INTO issue_map (card_id, issue_number, state, checksum, updated_at) VALUES ('c-done', 7, 'closed', 'chk-1', ?)`,
    ).run(TS);

    const report = auditLegacyScope(db);
    const audit = auditOf(report, 'c-done');
    expect(audit?.cardClass).toBe('unclassified');
    expect(audit?.reasons).toEqual(['historical completion without accepted-revision records']);
    expect(report.diagnostics).toEqual([]);
  });

  test('tweak cards participate in the same classification', () => {
    const { db } = migratedDb('tweak');
    insertCard(db, 'c-tweak', { type: 'tweak', lane: 'active', research: null });
    insertTask(db, 'c-tweak', 0, 't-twk', 'tweak work');
    insertState(db, 't-twk', 'c-tweak');

    const report = auditLegacyScope(db);
    expect(auditOf(report, 'c-tweak')?.cardClass).toBe('safe');
  });

  test('audit is read-only: rows and repeat results identical', () => {
    const { db } = migratedDb('readonly');
    insertCard(db, 'c-r1');
    insertCard(db, 'c-r2', { lane: 'done', completed_at: TS });
    insertTask(db, 'c-r1', 0, 't-r', 'work');
    insertState(db, 't-r', 'c-r1');
    insertSpec(db, 'c-r2');

    const before = db.query(
      `SELECT 'cards' AS t, COUNT(*) AS n FROM cards UNION ALL SELECT 'tasks', COUNT(*) FROM tasks
       UNION ALL SELECT 'task_state', COUNT(*) FROM task_state UNION ALL SELECT 'specs', COUNT(*) FROM specs
       UNION ALL SELECT 'scope_items', COUNT(*) FROM scope_items`,
    ).all();
    const first = auditLegacyScope(db);
    const second = auditLegacyScope(db);
    const after = db.query(
      `SELECT 'cards' AS t, COUNT(*) AS n FROM cards UNION ALL SELECT 'tasks', COUNT(*) FROM tasks
       UNION ALL SELECT 'task_state', COUNT(*) FROM task_state UNION ALL SELECT 'specs', COUNT(*) FROM specs
       UNION ALL SELECT 'scope_items', COUNT(*) FROM scope_items`,
    ).all();

    expect(second).toEqual(first);
    expect(after).toEqual(before);
  });
});

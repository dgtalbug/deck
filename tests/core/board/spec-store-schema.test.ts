import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { tmpProject } from '../../helpers.ts';

// Task 1.2 — the migration lands the spec-store tables on an existing board
// and they are queryable + idempotent on reopen.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-spec-schema-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

describe('spec store schema', () => {
  test('migration creates specs, issue_map, publish_queue tables', () => {
    const tables = store.db.all<{ name: string }>(
      // eslint-disable-next-line no-template-curly-in-string -- raw table list
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('specs','issue_map','publish_queue')",
    ).map((row) => row.name);
    expect(tables.sort()).toEqual(['issue_map', 'publish_queue', 'specs']);
  });

  test('reopening applies the migration idempotently', async () => {
    const again = await openStore(project.path);
    expect(again.dbPath).toBe(store.dbPath);
    const tables = again.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('specs','issue_map','publish_queue')",
    ).map((row) => row.name);
    expect(tables).toHaveLength(3);
  });
});

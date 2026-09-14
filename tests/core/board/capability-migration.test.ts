import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { tmpProject } from '../../helpers.ts';

let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-capability-migration-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

describe('capability projection migration', () => {
  test('creates capability metadata tables without disturbing existing board tables', () => {
    const tables = store.db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
          "('cards','specs','evidence_records','capability_statements','capability_previews','capability_versions','capability_deltas')",
      )
      .map((row) => row.name)
      .sort();

    expect(tables).toEqual([
      'capability_deltas',
      'capability_previews',
      'capability_statements',
      'capability_versions',
      'cards',
      'evidence_records',
      'specs',
    ]);
  });

  test('existing writer floor refusal still protects incompatible databases', async () => {
    store.raw()
      .query("INSERT INTO deck_meta (key, value) VALUES ('min_writer_version', '99.0.0') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run();

    await expect(openStore(project.path)).rejects.toThrow(/requires deck >= 99\.0\.0/);
  });
});

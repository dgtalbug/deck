import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { issueMap } from '../../../src/core/board/schema.ts';
import { tmpProject } from '../../helpers.ts';

// Task 2.2 (with 2.1/3.1/4.1 storage) — additive evidence/ledger/delivery
// tables, legacy provider mappings importing as recorded-but-unobserved,
// old-writer refusal after the floor rises, idempotent reopen.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-evidence-migration-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

describe('evidence/delivery migration', () => {
  test('migration creates the evidence, ledger and delivery tables', () => {
    const tables = store.db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
          "('delivery_policies','evidence_records','provider_operations','deliveries','cleanup_tasks')",
      )
      .map((row) => row.name)
      .sort();
    expect(tables).toEqual(
      ['cleanup_tasks', 'deliveries', 'delivery_policies', 'evidence_records', 'provider_operations'],
    );
  });

  test('legacy issue_map rows import as legacy-unobserved provider intent, once', async () => {
    const now = new Date().toISOString();
    store.db
      .insert(issueMap)
      .values({ cardId: 'legacy-card-1', issueNumber: 42, state: 'open', checksum: 'x', updatedAt: now })
      .onConflictDoNothing()
      .run();
    // Simulate a board that predates the ledger: clear the one-time flag, the
    // rows the first open already imported, and the migration record that
    // owns the import, then reopen — the upgrade re-imports, exactly once.
    store.raw().query("DELETE FROM provider_operations WHERE id LIKE 'pop-legacy-%'").run();
    store.raw().query("DELETE FROM deck_meta WHERE key = 'provider_ledger_migrated'").run();
    store.raw().exec("DELETE FROM migration_runs WHERE migration = '20260919120000_control_plane_baseline'");
    const again = await openStore(project.path);
    const { providerOperations } = await import('../../../src/core/board/schema.ts');
    const legacy = again.db.select().from(providerOperations).all().filter((row) => row.cardId === 'legacy-card-1');
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.state).toBe('legacy-unobserved');
    expect(legacy[0]!.remoteId).toBe('42');
    // reopen once more — still exactly one row (idempotent import)
    const third = await openStore(project.path);
    const after = third.db
      .select()
      .from(providerOperations)
      .all()
      .filter((row) => row.cardId === 'legacy-card-1');
    expect(after).toHaveLength(1);
  });

  test('old-writer refusal: a floor above the binary refuses before any write', async () => {
    store.raw()
      .query("INSERT INTO deck_meta (key, value) VALUES ('min_writer_version', '99.0.0') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run();
    await expect(openStore(project.path)).rejects.toThrow(/requires deck >= 99\.0\.0/);
    // restore the floor for the remaining tests
    store.raw()
      .query("UPDATE deck_meta SET value = '0.6.0' WHERE key = 'min_writer_version'")
      .run();
  });

  test('historical done cards are untouched by migration (no implicit enrollment)', async () => {
    const doneCards = store.db.select().from(issueMap).where(eq(issueMap.state, 'open')).all();
    expect(doneCards.length).toBeGreaterThan(0); // fixture sanity
    const policies = store.db.all<{ card_id: string }>('SELECT card_id FROM delivery_policies');
    expect(policies).toHaveLength(0);
  });
});

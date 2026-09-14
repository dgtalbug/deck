import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { cards } from '../../src/core/board/schema.ts';
import { summaryPage } from '../../src/core/board/summaries.ts';
import { firstReady, mostAdvancedActive } from '../../src/core/board/lanes.ts';
import { boardFixture, stats, warmSamples } from './lib.ts';

// D5 small-workload acceptance: 100 live records / 500 task rows plus 1,000
// retained historical stories. Asserts page/selection latency distributions,
// SQL statement counts (no whole-queue task hydration) and index use.
// Budgets live in tests/performance/benchmark-manifest.json (frozen).
describe('small workload acceptance', () => {
  test('live/history pages and selection stay within frozen budgets', async () => {
    const fixture = await boardFixture({ stories: 0, epics: 0 });
    const store = fixture.store;
    try {
      // 99 live done stories x 5 tasks + 1 live epic = 100 records / 495+5=500 tasks
      for (let i = 0; i < 99; i++) {
        const note = store.addNote(`live ${i}`);
        const item = convertToVerbItem(store, {
          noteId: note.id,
          proposedVerb: 'feat',
          refinedTitle: `live ${i}`,
          research: { codebaseFindings: ['has spec content'], sections: { what: 'w', why: 'y' } },
          specDeltas: [],
          tasks: ['a', 'b', 'c', 'd', 'e'],
          openQuestions: [],
        });
        moveLane(store, item.id, 'done', 'engine');
      }
      const queued = makeQueued(store);
      store.addEpic('live epic');

      // 1,000 historical stories inserted directly (retained facts only)
      for (let b = 0; b < 10; b++) {
        const rows = Array.from({ length: 100 }, (_, i) =>
          `('h-${b}-${i}', 'verb', 'history ${b}-${i}', 'feat', 'done', ${i + b * 100}, NULL, NULL, '{"codebaseFindings":[]}', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-14T00:00:00Z')`,
        ).join(', ');
        store.raw().run(
          'INSERT OR IGNORE INTO cards (id, type, title, verb, lane, position, epic_id, scope_revision, research, created_at, updated_at, completed_at, history_at) VALUES ' + rows,
        );
      }

      const liveCounts = store.raw().query("SELECT count(*) c FROM cards WHERE history_at IS NULL AND type IN ('epic','verb')").get() as { c: number };
      expect(liveCounts.c).toBeLessThanOrEqual(101); // 100-record fixture plus the queued target
      const historyCount = store.raw().query("SELECT count(*) c FROM cards WHERE history_at IS NOT NULL").get() as { c: number };
      expect(historyCount.c).toBeGreaterThanOrEqual(1000);

      // --- statement counts (bounded page / selection reads) ---
      const livePageCount = countStatements(store, () => summaryPage(store, { limit: 25 }));
      expect(livePageCount).toBeLessThanOrEqual(10);
      const historyPageCount = countStatements(store, () => summaryPage(store, { view: 'history', limit: 25 }));
      expect(historyPageCount).toBeLessThanOrEqual(10);
      const selectionCount = countStatements(store, () => {
        mostAdvancedActive(store);
        firstReady(store);
      });
      expect(selectionCount).toBeLessThanOrEqual(10);

      // --- index use: the paged keyset read must not full-scan cards ---
      const plan = store.raw().query("EXPLAIN QUERY PLAN SELECT id FROM cards WHERE history_at IS NULL ORDER BY position ASC, rowid ASC LIMIT 25").all() as Array<{ detail: string }>;
      const detailText = plan.map((row) => row.detail).join(' | ');
      expect(detailText).toContain('cards_history');
      expect(detailText).not.toMatch(/SCAN cards USING NONE|SCAN 2 TABLES/);

      // --- latency distributions (30 warm samples) ---
      const livePage = stats(await warmSamples(30, () => void summaryPage(store, { limit: 25 })));
      const historyPage = stats(await warmSamples(30, () => void summaryPage(store, { view: 'history', limit: 25 })));
      const selection = stats(await warmSamples(30, () => void firstReady(store)));
      expect(livePage.p95).toBeLessThanOrEqual(100);
      expect(historyPage.p95).toBeLessThanOrEqual(100);
      expect(selection.p95).toBeLessThanOrEqual(100);

      // the queued story is still discoverable next to 1000 historical rows
      expect(firstReady(store).card?.id).toBe(queued);
    } finally {
      fixture.cleanup();
    }
  }, 120_000);
});

function makeQueued(store: DocumentStore): string {
  const note = store.addNote('queued target');
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: 'queued target',
    research: { codebaseFindings: ['has spec content'], sections: { what: 'w', why: 'y' } },
    specDeltas: [],
    tasks: ['one'],
    openQuestions: [],
  });
  moveLane(store, item.id, 'groomed', 'human');
  return item.id;
}

function countStatements(store: DocumentStore, fn: () => unknown): number {
  const raw = store.raw();
  // drizzle and raw reads funnel through query/prepare/run on the same handle
  const patch = (method: 'query' | 'prepare' | 'run'): boolean => {
    const holder = raw as unknown as Record<string, unknown>;
    const original = (holder[method] as (...a: unknown[]) => unknown).bind(raw);
    if (typeof holder[method] !== 'function') return false;
    holder[method] = (...args: unknown[]) => {
      count += 1;
      return original(...args);
    };
    return true;
  };
  let count = 0;
  const patched: Array<'query' | 'prepare' | 'run'> = [];
  for (const method of ['query', 'prepare', 'run'] as const) if (patch(method)) patched.push(method);
  try {
    fn();
  } finally {
    for (const method of patched) delete (raw as unknown as Record<string, unknown>)[method];
  }
  return count;
}

void sql;

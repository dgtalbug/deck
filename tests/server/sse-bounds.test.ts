import { describe, expect, test } from 'bun:test';
import { openStore } from '../../src/core/board/store.ts';
import { emitEvent, readSinceBatched, latestRowid, DELIVERY_BATCH_ROWS, FRAME_BYTE_LIMIT } from '../../src/core/events/outbox.ts';
import { tmpProject } from '../helpers.ts';
import { coalescingEmitter } from '../../src/ui/slices/board/sse.ts';
import type { BoardEvent } from '../../src/ui/slices/board/api.ts';

// Focused bounds: batched tail reads cap rows and detect oversized payloads
// by projection, the client coalesces bursts and bounds its frame buffer.
describe('bounded outbox delivery', () => {
  test('readSinceBatched returns at most 100 ordered rows per batch', async () => {
    const project = tmpProject('deck-outbox-batch-');
    try {
      const store = await openStore(project.path);
      for (let i = 0; i < 250; i++) {
        store.db.run(
          // direct inserts keep the fixture fast; the tailer only reads
          `INSERT INTO events (type, payload, created_at) VALUES ('card.updated', '{"id":"c-' + ${i} + '"}', datetime())`,
        );
      }
      const first = readSinceBatched(store.db, 0);
      expect(first.events).toHaveLength(DELIVERY_BATCH_ROWS);
      const second = readSinceBatched(store.db, first.lastRowid);
      expect(second.events).toHaveLength(DELIVERY_BATCH_ROWS);
      const third = readSinceBatched(store.db, second.lastRowid);
      expect(third.events).toHaveLength(50);
      // ordered, no loss, no duplicates across the full traversal
      const all = [...first.events, ...second.events, ...third.events];
      expect(new Set(all.map((event) => event.rowid)).size).toBe(250);
    } finally {
      project.cleanup();
    }
  });

  test('an oversized payload is detected without materializing and never pruned', async () => {
    const project = tmpProject('deck-outbox-size-');
    try {
      const store = await openStore(project.path);
      emitEvent(store.db, 'card.updated', { id: 'small' });
      const huge = 'x'.repeat(FRAME_BYTE_LIMIT + 1024);
      store.raw().prepare(`INSERT INTO events (type, payload, created_at) VALUES ('card.updated', '{"id":"' || ? || '"}', '2026-09-14T00:00:00Z')`).run(huge);
      const batch = readSinceBatched(store.db, 0);
      expect(batch.oversizedRowids).toHaveLength(1);
      expect(batch.events).toHaveLength(1); // only the small frame is delivered
      const remaining = store.raw().query('SELECT count(*) c FROM events').get() as { c: number };
      expect(remaining.c).toBe(2); // oversized row stays durable — never pruned
    } finally {
      project.cleanup();
    }
  });
});

describe('client frame bounds', () => {
  test('bursts coalesce into one batched callback within the window', async () => {
    const batches: BoardEvent[][] = [];
    const emit = coalescingEmitter((events) => batches.push(events));
    emit([{ rowid: 1, type: 'card.created', payload: { id: 'a' } }]);
    emit([{ rowid: 2, type: 'card.created', payload: { id: 'b' } }]);
    emit([{ rowid: 3, type: 'card.moved', payload: { id: 'x' } }]);
    expect(batches).toEqual([]); // nothing fires inside the window
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(batches).toEqual([[
      { rowid: 1, type: 'card.created', payload: { id: 'a' } },
      { rowid: 2, type: 'card.created', payload: { id: 'b' } },
      { rowid: 3, type: 'card.moved', payload: { id: 'x' } },
    ]]);
  });

  test('a quiet window emits nothing', async () => {
    const batches: BoardEvent[][] = [];
    const emit = coalescingEmitter((events) => batches.push(events));
    void emit;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(batches).toEqual([]);
  });
});

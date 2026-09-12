import { eq } from 'drizzle-orm';
import { DeckError } from './errors.ts';
import { newTaskId } from './ids.ts';
import { endPosition } from './positions.ts';
import { cards, tasks } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';
import type { Card, VerifyResult } from './types.ts';
import { emitEvent } from '../events/outbox.ts';

function nowIso(): string {
  return new Date().toISOString();
}

// The board only APPLIES verify outcomes; the converge loop itself is
// engine-owned (epic Feasibility 6).
export function applyVerifyResult(
  store: DocumentStore,
  id: string,
  result: VerifyResult,
  newTasks: string[] = [],
): Card {
  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, id)).get();
    if (!row || (row.type !== 'verb' && row.type !== 'tweak') || row.lane !== 'verify') {
      throw new DeckError(
        `card ${id} is not in verify — applyVerifyResult runs on verify-lane verb items and tweaks`,
        { cardId: id, type: row?.type ?? 'missing', lane: row?.lane ?? 'missing' },
      );
    }
    const position = endPosition(
      tx
        .select({ position: cards.position })
        .from(cards)
        .where(eq(cards.lane, result === 'clean' ? 'done' : 'active'))
        .all()
        .map((laneRow) => laneRow.position),
    );
    tx.update(cards)
      .set({ lane: result === 'clean' ? 'done' : 'active', position, updatedAt: nowIso() })
      .where(eq(cards.id, id))
      .run();

    if (result === 'gaps' && newTasks.length > 0) {
      const existing = tx.select({ idx: tasks.idx }).from(tasks).where(eq(tasks.cardId, id)).all();
      let idx = existing.length > 0 ? Math.max(...existing.map((taskRow) => taskRow.idx)) + 1 : 0;
      for (const title of newTasks) {
        tx.insert(tasks)
          .values({ cardId: id, idx, id: newTaskId(), title, done: false, addedByVerify: true })
          .run();
        idx += 1;
      }
      const all = tx.select().from(tasks).where(eq(tasks.cardId, id)).all();
      const done = all.filter((taskRow) => taskRow.done).length;
      emitEvent(tx, 'card.tasks.updated', {
        id,
        tasks: all.map((taskRow) => ({ title: taskRow.title, done: taskRow.done })),
        progress: `${done}/${all.length}`,
      });
    }
    emitEvent(tx, 'card.moved', { id, lane: result === 'clean' ? 'done' : 'active', position });
    if (result === 'clean') {
      // wikiPath fills in when the engine's archive step lands; the event
      // contract carries it from day one.
      emitEvent(tx, 'card.done', { id, wikiPath: '' });
    }
  });
  return store.getCard(id);
}

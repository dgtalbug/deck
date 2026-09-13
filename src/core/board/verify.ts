import { eq } from 'drizzle-orm';
import { DeckError } from './errors.ts';
import { moveLane } from './lanes.ts';
import { newTaskId } from './ids.ts';
import { endPosition } from './positions.ts';
import { cards, tasks } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';
import { isTweak, isVerbItem, type Card, type VerifyResult } from './types.ts';
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

// The ONE explicit-result door core (transport-consistent verification):
// CLI --result and the MCP task_sync tool both land here, so `clean` means
// the same thing through every door. An ordinary verb's clean HOLDS in
// verify — done is finalization's alone (the archive path is the only
// applyVerifyResult('clean') caller). A tweak's clean completes per the
// tweak's own explicit policy (no spec, no converge loop). Gaps flow through
// applyVerifyResult for both kinds. Invalid input changes nothing.
export function applyExplicitResult(
  store: DocumentStore,
  id: string,
  result: VerifyResult,
  newTasks: string[] = [],
): Card {
  const card = store.getCard(id);
  if (!isVerbItem(card) && !isTweak(card)) {
    throw new DeckError(`card ${id} is not a build card — explicit verify results apply to verb items and tweaks`, {
      cardId: id,
    });
  }
  if (card.lane !== 'active' && card.lane !== 'verify') {
    throw new DeckError(
      `card ${id} is in ${card.lane} — explicit verify results apply to active or verify cards`,
      { cardId: id, lane: card.lane },
    );
  }
  if (card.lane === 'active') moveLane(store, id, 'verify', 'engine');
  if (result === 'clean' && isVerbItem(card)) {
    // Hold: the card stays in verify; review + archive close it. No done
    // event, no provider call — completion belongs to finalization only.
    return store.getCard(id);
  }
  return applyVerifyResult(store, id, result, newTasks);
}

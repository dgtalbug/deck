import { eq } from 'drizzle-orm';
import { DeckError } from './errors.ts';
import { moveLane } from './lanes.ts';
import { newTaskId } from './ids.ts';
import { endPosition } from './positions.ts';
import { cards, cleanupTasks, deliveries, tasks } from './schema.ts';
import { runTx, type DocumentStore, type Tx } from './store.ts';
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
      const existingTitles = new Set(
        tx.select({ title: tasks.title }).from(tasks).where(eq(tasks.cardId, id)).all().map((taskRow) => taskRow.title),
      );
      let idx = existing.length > 0 ? Math.max(...existing.map((taskRow) => taskRow.idx)) + 1 : 0;
      // Identity-linked repair tasks dedupe by title: the same gap repeating
      // across converge loops appends nothing (title carries the criterion id
      // when the gap is an evidence gap).
      for (const title of newTasks) {
        if (existingTitles.has(title)) continue;
        existingTitles.add(title);
        tx.insert(tasks)
          .values({ cardId: id, idx, id: newTaskId(), title, done: false, addedByVerify: true })
          .run();
        idx += 1;
      }
      if (idx > (existing.length > 0 ? Math.max(...existing.map((taskRow) => taskRow.idx)) + 1 : 0)) {
        const all = tx.select().from(tasks).where(eq(tasks.cardId, id)).all();
        const done = all.filter((taskRow) => taskRow.done).length;
        emitEvent(tx, 'card.tasks.updated', {
          id,
          tasks: all.map((taskRow) => ({ title: taskRow.title, done: taskRow.done })),
          progress: `${done}/${all.length}`,
        });
      }
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

// The private finalization core (E05 DECK-ARCH-014, design decision 6):
// completion is written by delivery finalization ONLY — uniquely keyed by the
// delivery attempt, all in one transaction (lane move, done event, delivery
// record, cleanup intents). A concurrent or repeated finalization observes
// the recorded outcome instead of emitting a second completion.
export function completeFromDelivery(
  store: DocumentStore,
  id: string,
  deliveryId: string,
): { card: Card; delivered: boolean } {
  return runTxReturning(store.db, (tx) => {
    const delivery = tx.select().from(deliveries).where(eq(deliveries.id, deliveryId)).get();
    if (delivery === undefined) {
      throw new DeckError(`delivery '${deliveryId}' not found — finalization needs a recorded delivery`, {
        cardId: id,
        deliveryId,
      });
    }
    const row = tx.select().from(cards).where(eq(cards.id, id)).get();
    if (row === undefined || (row.type !== 'verb' && row.type !== 'tweak')) {
      throw new DeckError(`card ${id} is not a build card — completion applies to build cards`, {
        cardId: id,
        type: row?.type ?? 'missing',
      });
    }
    if (row.lane === 'done') {
      // Already completed (concurrent finalizer or retry): return the
      // recorded outcome, never a duplicate event.
      return { card: store.getCard(id), delivered: false };
    }
    if (row.lane !== 'verify') {
      throw new DeckError(`card ${id} is in ${row.lane} — completion finalizes verify-lane cards`, {
        cardId: id,
        lane: row.lane,
      });
    }
    const position = endPosition(
      tx.select({ position: cards.position }).from(cards).where(eq(cards.lane, 'done')).all().map((laneRow) => laneRow.position),
    );
    tx.update(cards).set({ lane: 'done', position, updatedAt: nowIso() }).where(eq(cards.id, id)).run();
    const deliveredSha = delivery.deliveredSha ?? delivery.mergeSha ?? delivery.headSha;
    emitEvent(tx, 'card.done', { id, wikiPath: '' });
    emitEvent(tx, 'card.moved', { id, lane: 'done', position });
    // Retryable cleanup intents for the delivered identity — issue close,
    // branch delete, changelog and eligible release (delivery-cleanup).
    const ts = nowIso();
    const kinds: Array<'issue-close' | 'branch-delete' | 'changelog' | 'release'> = [
      'issue-close',
      'branch-delete',
      'changelog',
      'release',
    ];
    for (const kind of kinds) {
      tx.insert(cleanupTasks)
        .values({
          id: `cl-${deliveryId}-${kind}`,
          cardId: id,
          deliveryId,
          kind,
          state: 'pending',
          attempts: 0,
          createdAt: ts,
          updatedAt: ts,
        })
        .onConflictDoNothing()
        .run();
    }
    tx.update(deliveries)
      .set({ state: 'delivered', deliveredSha, updatedAt: ts })
      .where(eq(deliveries.id, deliveryId))
      .run();
    return { card: store.getCard(id), delivered: true };
  });
}

// runTx with a return value (drizzle transactions return void; this wraps).
function runTxReturning<R>(db: Parameters<typeof runTx>[0], fn: (tx: Tx) => R): R {
  let result!: R;
  runTx(db, (tx) => {
    result = fn(tx);
  });
  return result;
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

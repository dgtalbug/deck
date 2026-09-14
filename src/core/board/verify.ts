import { eq } from 'drizzle-orm';
import { DeckError } from './errors.ts';
import { moveLane } from './lanes.ts';
import { newTaskId } from './ids.ts';
import { endPosition } from './positions.ts';
import { cards, cleanupTasks, deliveries, tasks } from './schema.ts';
import { runTx, type DocumentStore, type Tx } from './store.ts';
import { runRetention } from './history.ts';
import { isTweak, isVerbItem, type Card, type VerifyResult } from './types.ts';
import { emitEvent } from '../events/outbox.ts';

function nowIso(): string {
  return new Date().toISOString();
}

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
      .set({
        lane: result === 'clean' ? 'done' : 'active',
        position,
        updatedAt: nowIso(),
        ...(result === 'clean' ? { completedAt: nowIso() } : {}),
      })
      .where(eq(cards.id, id))
      .run();

    if (result === 'gaps' && newTasks.length > 0) {
      const existing = tx.select({ idx: tasks.idx }).from(tasks).where(eq(tasks.cardId, id)).all();
      const existingTitles = new Set(
        tx.select({ title: tasks.title }).from(tasks).where(eq(tasks.cardId, id)).all().map((taskRow) => taskRow.title),
      );
      let idx = existing.length > 0 ? Math.max(...existing.map((taskRow) => taskRow.idx)) + 1 : 0;
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
      emitEvent(tx, 'card.done', { id, wikiPath: '' });
    }
  });
  if (result === 'clean') runRetention(store);
  return store.getCard(id);
}

export function completeFromDelivery(
  store: DocumentStore,
  id: string,
  deliveryId: string,
): { card: Card; delivered: boolean } {
  const outcome = runTxReturning(store.db, (tx) => {
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
    tx.update(cards).set({ lane: 'done', position, updatedAt: nowIso(), completedAt: nowIso() }).where(eq(cards.id, id)).run();
    const deliveredSha = delivery.deliveredSha ?? delivery.mergeSha ?? delivery.headSha;
    emitEvent(tx, 'card.done', { id, wikiPath: '' });
    emitEvent(tx, 'card.moved', { id, lane: 'done', position });
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
  runRetention(store);
  return outcome;
}

function runTxReturning<R>(db: Parameters<typeof runTx>[0], fn: (tx: Tx) => R): R {
  let result!: R;
  runTx(db, (tx) => {
    result = fn(tx);
  });
  return result;
}

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
    return store.getCard(id);
  }
  return applyVerifyResult(store, id, result, newTasks);
}

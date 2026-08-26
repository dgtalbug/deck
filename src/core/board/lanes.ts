import { eq } from 'drizzle-orm';
import { LaneViolation, WipLimitError } from './errors.ts';
import { endPosition } from './positions.ts';
import { cards } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';
import { MANUAL_TRANSITIONS, isTweak, isVerbItem, type Lane, type Tweak, type VerbItem } from './types.ts';
import { emitEvent } from '../events/outbox.ts';

function nowIso(): string {
  return new Date().toISOString();
}

export function assertTransition(
  cardId: string,
  from: Lane,
  to: Lane,
  source: 'human' | 'engine',
): void {
  if (from === to) return;
  const key = `${from}->${to}`;
  const manual = (MANUAL_TRANSITIONS as readonly string[]).includes(key);
  if (!manual && source !== 'engine') {
    throw new LaneViolation(cardId, from, to, source);
  }
}

export function mostAdvancedActive(store: DocumentStore): VerbItem | Tweak | undefined {
  const actives = store
    .listCards('active')
    .flatMap((card) => (isVerbItem(card) || isTweak(card) ? [card] : []));
  if (actives.length === 0) return undefined;
  const doneCount = (card: VerbItem | Tweak) =>
    isVerbItem(card) ? card.tasks.filter((task) => task.done).length : 0;
  return actives.sort((a, b) => {
    const diff = doneCount(b) - doneCount(a);
    if (diff !== 0) return diff;
    return b.updatedAt.localeCompare(a.updatedAt);
  })[0];
}

export function assertUnderWip(store: DocumentStore): void {
  const active = store.activeCount();
  if (active >= store.wipLimit) {
    const top = mostAdvancedActive(store);
    throw new WipLimitError(active, store.wipLimit, top?.id ?? 'unknown');
  }
}

export function activeCount(store: DocumentStore): number {
  return store.activeCount();
}

export function topOfQueue(store: DocumentStore): VerbItem | undefined {
  return store
    .listCards('groomed')
    .filter(isVerbItem)
    .filter((card) => card.blocked === undefined)[0];
}

export function moveLane(
  store: DocumentStore,
  id: string,
  to: Lane,
  source: 'human' | 'engine' = 'human',
): VerbItem {
  const card = store.getCard(id);
  if (!('lane' in card)) {
    // Notes only leave todo through grooming or tweak — never a lane move.
    throw new LaneViolation(id, 'todo', to, source);
  }
  assertTransition(id, card.lane, to, source);
  if (to === 'active' && card.lane !== 'active') assertUnderWip(store);

  let position = 0;
  runTx(store.db, (tx) => {
    const lanePositions = tx
      .select({ position: cards.position })
      .from(cards)
      .where(eq(cards.lane, to))
      .all()
      .map((row) => row.position);
    position = endPosition(lanePositions);
    tx.update(cards)
      .set({ lane: to, position, updatedAt: nowIso() })
      .where(eq(cards.id, id))
      .run();
    emitEvent(tx, 'card.moved', { id, lane: to, position });
  });
  return store.getVerbItem(id);
}

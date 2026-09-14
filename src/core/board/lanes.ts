import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { LaneViolation, WipLimitError } from './errors.ts';
import { endPosition } from './positions.ts';
import { cards, tasks } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';
import { MANUAL_TRANSITIONS, isTweak, isVerbItem, type Card, type Lane, type Tweak, type VerbItem } from './types.ts';
import { emitEvent } from '../events/outbox.ts';
import { unmetDependencies } from './planning.ts';
import { runRetention } from './history.ts';

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
  // Lightweight candidate read: task progress comes from one aggregate query,
  // and only the selected card is hydrated.
  const rows = store.db
    .select({ id: cards.id, type: cards.type, updatedAt: cards.updatedAt })
    .from(cards)
    .where(and(eq(cards.lane, 'active'), or(eq(cards.type, 'verb'), eq(cards.type, 'tweak'))))
    .all();
  if (rows.length === 0) return undefined;
  const doneCounts = new Map(
    store.db
      .select({ cardId: tasks.cardId, done: sql<number>`sum(case when ${tasks.done} then 1 else 0 end)` })
      .from(tasks)
      .where(
        sql`${tasks.cardId} IN (${sql.join(
          rows.map((row) => sql`${row.id}`),
          sql`, `,
        )})`,
      )
      .groupBy(tasks.cardId)
      .all()
      .map((row) => [row.cardId, row.done]),
  );
  const top = rows.sort((a, b) => {
    const diff = (doneCounts.get(b.id) ?? 0) - (doneCounts.get(a.id) ?? 0);
    if (diff !== 0) return diff;
    return b.updatedAt.localeCompare(a.updatedAt);
  })[0]!;
  const card = store.getCard(top.id);
  return isVerbItem(card) || isTweak(card) ? card : undefined;
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

export interface ReadySelection {
  card: VerbItem | undefined;
  skipped: Array<{ card: VerbItem; blockers: Array<{ id: string; lane: string; title: string }> }>;
}

export function firstReady(store: DocumentStore): ReadySelection {
  // Queue scan uses lightweight candidate rows (no task hydration); only the
  // chosen card and explicitly skipped blockers are hydrated.
  const candidates = store.db
    .select({ id: cards.id, position: cards.position })
    .from(cards)
    .where(and(eq(cards.lane, 'groomed'), eq(cards.type, 'verb'), isNull(cards.blockedReason)))
    .orderBy(asc(cards.position), sql`rowid`)
    .all();
  const skipped: ReadySelection['skipped'] = [];
  for (const candidate of candidates) {
    const blockers = unmetDependencies(store, candidate.id);
    if (blockers.length === 0) {
      const card = store.getVerbItem(candidate.id);
      return { card, skipped };
    }
    skipped.push({ card: store.getVerbItem(candidate.id), blockers });
  }
  return { card: undefined, skipped };
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
): Card {
  const card = store.getCard(id);
  if (!('lane' in card)) {
    throw new LaneViolation(id, 'todo', to, source);
  }
  assertTransition(id, card.lane, to, source);
  if (to === 'active' && card.lane !== 'active') assertUnderWip(store);

  let position = 0;
  const leavingDone = card.lane === 'done' && to !== 'done';
  runTx(store.db, (tx) => {
    const lanePositions = tx
      .select({ position: cards.position })
      .from(cards)
      .where(eq(cards.lane, to))
      .all()
      .map((row) => row.position);
    position = endPosition(lanePositions);
    tx.update(cards)
      .set({
        lane: to,
        position,
        updatedAt: nowIso(),
        // Completion is stamped once on entering done; leaving done revives
        // work and clears visibility history for the card and its parent.
        ...(to === 'done' && card.completedAt === undefined ? { completedAt: nowIso() } : {}),
        ...(leavingDone ? { historyAt: null } : {}),
      })
      .where(eq(cards.id, id))
      .run();
    if (leavingDone) {
      const row = tx.select({ epicId: cards.epicId }).from(cards).where(eq(cards.id, id)).get();
      if (row?.epicId !== null && row?.epicId !== undefined) {
        tx.update(cards).set({ historyAt: null }).where(eq(cards.id, row.epicId)).run();
      }
    }
    emitEvent(tx, 'card.moved', { id, lane: to, position });
  });
  if (to === 'done') runRetention(store);
  return store.getCard(id);
}

import { existsSync } from 'node:fs';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { DeckError } from './errors.ts';
import { cards, operations } from './schema.ts';
import type { DocumentStore } from './store.ts';

const UNSETTLED = ['reserved', 'active', 'recovery-required'] as const;

export class RecoveryRequiredError extends DeckError {}

export function executionPath(store: DocumentStore, cardId: string): string {
  const card = store.db.select({ lane: cards.lane }).from(cards).where(eq(cards.id, cardId)).get();
  const inFlight = card !== undefined && (card.lane === 'active' || card.lane === 'verify');
  // while the card is executing, its durable assignment is the checkout of the
  // latest uncompensated start operation — the operation row may already be completed
  const assigned = inFlight
    ? store.db
        .select({ checkout: operations.checkout, id: operations.id, state: operations.state })
        .from(operations)
        .where(and(eq(operations.cardId, cardId), eq(operations.kind, 'start'), ne(operations.state, 'compensated')))
        .orderBy(desc(operations.createdAt))
        .all()
        .at(0)
    : store.db
        .select({ checkout: operations.checkout, id: operations.id, state: operations.state })
        .from(operations)
        .where(and(eq(operations.cardId, cardId), inArray(operations.state, [...UNSETTLED])))
        .all()
        .at(0);
  if (assigned === undefined) return store.projectPath;
  if (!existsSync(assigned.checkout)) {
    throw new RecoveryRequiredError(
      `card ${cardId} is assigned to checkout ${assigned.checkout} (operation ${assigned.id}, ${assigned.state}) but that path is missing — ` +
        `restore it or reconcile the operation; execution never falls back to the canonical checkout`,
      { cardId, operationId: assigned.id, checkout: assigned.checkout },
    );
  }
  return assigned.checkout;
}

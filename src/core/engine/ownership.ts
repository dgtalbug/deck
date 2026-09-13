// Execution ownership (engine/ownership): card starts are reserved atomically
// so two requests can never both act on one card, and each checkout has at
// most one execution owner across start, review and archive. A reservation is
// a row in `operations` (inspectable after a crash, unlike a mutex); every
// completion, release and compensation is owner-conditional, so a stale
// writer can never touch a state it no longer owns. Recovery is explicit —
// no lease expiry, no timeout takeover (DECK-ARCH-003/004 exclusions).
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { DeckError } from '../board/errors.ts';
import { WipLimitError } from '../board/errors.ts';
import { operations, type OperationRow } from '../board/schema.ts';
import { runTx, type DocumentStore, type Tx } from '../board/store.ts';

export type OperationKind = OperationRow['kind'];
export type OperationState = OperationRow['state'];

// States that fence a checkout or a card. Completed/compensated are history.
export const UNSETTLED_STATES: OperationState[] = ['reserved', 'active', 'recovery-required'];

// One token per process instance: every CLI invocation and server process
// owns its operations; a sibling process's rows are foreign by definition.
export const ownerToken = `${process.pid}-${randomUUID()}`;

// Canonical checkout identity: symlink and copy aliases collapse to one
// realpath, so ownership guards cannot be walked around by path spelling.
export function canonicalCheckout(projectPath: string): string {
  return realpathSync(projectPath);
}

export class OperationConflictError extends DeckError {
  constructor(message: string, details: Record<string, unknown>) {
    super(message, details);
  }
}

// Raised when a writer's owner-conditional update matched zero rows: the
// operation was reconciled or taken over elsewhere — future launches by the
// stale owner are fenced (fail closed).
export class StaleOperationError extends DeckError {
  constructor(operationId: string, cardId: string, action: string) {
    super(
      `operation ${operationId} on card ${cardId} is no longer owned by this process — ` +
        `${action} refused; the operation was reconciled or recovered elsewhere (deck ops list)`,
      { operationId, cardId, action },
    );
  }
}

export interface Operation {
  id: string;
  cardId: string;
  kind: OperationKind;
  owner: string;
  checkout: string;
  state: OperationState;
  createdAt: string;
  updatedAt: string;
}

function toOperation(row: OperationRow): Operation {
  return { ...row };
}

function nowIso(): string {
  return new Date().toISOString();
}

// Unsettled operations on a checkout held by a DIFFERENT owner — the fence a
// new reservation must respect. Same-owner rows are this process's own work.
function foreignConflicts(tx: Tx, checkout: string, owner: string): OperationRow[] {
  return tx
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.checkout, checkout),
        inArray(operations.state, UNSETTLED_STATES),
        ne(operations.owner, owner),
      ),
    )
    .all();
}

// The reservation transaction core (DECK-ARCH-003): card state, checkout
// guard, WIP (counting reservations) and the reservation INSERT all happen in
// one BEGIN IMMEDIATE transaction, before any awaited hook runs. Callers
// re-derive typed 404s outside; the tx re-reads the row so the decision is
// made on serialized state.
export function reserveOperationInTx(
  tx: Tx,
  input: {
    cardId: string;
    kind: OperationKind;
    owner: string;
    checkout: string;
    // Serialized card-state re-validation (lane the card must currently sit in).
    expectLane?: string;
    // WIP accounting for start reservations: active cards + reserved ops.
    wip?: { limit: number; activeCount: number; topCardId: string };
  },
): Operation {
  const conflicts = foreignConflicts(tx, input.checkout, input.owner);
  if (conflicts.length > 0) {
    const other = conflicts[0]!;
    throw new OperationConflictError(
      `checkout ${input.checkout} is owned by operation ${other.id} (card ${other.cardId}, ${other.kind}, owner ${other.owner}, state ${other.state}) — ` +
        `reconcile it before starting work here (deck ops list / deck ops reconcile)`,
      { checkout: input.checkout, operationId: other.id, cardId: other.cardId, owner: other.owner, state: other.state },
    );
  }
  const sameCard = tx
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.cardId, input.cardId),
        eq(operations.kind, input.kind),
        inArray(operations.state, ['reserved', 'active']),
      ),
    )
    .all();
  if (sameCard.length > 0) {
    const other = sameCard[0]!;
    throw new OperationConflictError(
      `card ${input.cardId} is already reserved by operation ${other.id} (owner ${other.owner}) — ` +
        `one start owns the card; concurrent starts refuse`,
      { cardId: input.cardId, operationId: other.id, owner: other.owner },
    );
  }
  if (input.wip !== undefined) {
    const reserved = tx
      .select({ cardId: operations.cardId })
      .from(operations)
      .where(and(eq(operations.kind, 'start'), eq(operations.state, 'reserved')))
      .all();
    const used = input.wip.activeCount + new Set(reserved.map((row) => row.cardId)).size;
    if (used >= input.wip.limit) {
      throw new WipLimitError(used, input.wip.limit, input.wip.topCardId);
    }
  }
  const id = `op-${randomUUID()}`;
  const ts = nowIso();
  tx.insert(operations)
    .values({
      id,
      cardId: input.cardId,
      kind: input.kind,
      owner: input.owner,
      checkout: input.checkout,
      state: 'reserved',
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  return {
    id,
    cardId: input.cardId,
    kind: input.kind,
    owner: input.owner,
    checkout: input.checkout,
    state: 'reserved',
    createdAt: ts,
    updatedAt: ts,
  };
}

// Standalone reservation for doors whose guarded section is their whole body
// (review, archive) and for crash-point fixtures.
export function reserveOperation(
  store: DocumentStore,
  cardId: string,
  kind: OperationKind,
): Operation {
  let operation: Operation | undefined;
  runTx(store.db, (tx) => {
    operation = reserveOperationInTx(tx, {
      cardId,
      kind,
      owner: ownerToken,
      checkout: canonicalCheckout(store.projectPath),
    });
  });
  return operation!;
}

// Owner-conditional transition: the UPDATE matches only when the operation is
// still unsettled AND still ours. Zero rows → someone else recovered it.
function transitionOperation(
  store: DocumentStore,
  operationId: string,
  from: OperationState[],
  to: OperationState,
  action: string,
): Operation {
  const ts = nowIso();
  let updated: Operation | undefined;
  runTx(store.db, (tx) => {
    const rows = tx
      .update(operations)
      .set({ state: to, updatedAt: ts })
      .where(and(eq(operations.id, operationId), inArray(operations.state, from), eq(operations.owner, ownerToken)))
      .returning()
      .all();
    if (rows.length > 0) updated = toOperation(rows[0]!);
  });
  if (updated === undefined) {
    const row = store.db.select().from(operations).where(eq(operations.id, operationId)).get();
    throw new StaleOperationError(operationId, row?.cardId ?? 'unknown', action);
  }
  return updated;
}

export function activateOperation(store: DocumentStore, operationId: string): Operation {
  return transitionOperation(store, operationId, ['reserved'], 'active', 'activation');
}

// Completion and compensation both end the reservation; both are
// owner-conditional, so a loser request can never reset the winner's state.
export function completeOperation(store: DocumentStore, operationId: string): Operation {
  return transitionOperation(store, operationId, ['reserved', 'active'], 'completed', 'completion');
}

export function compensateOperation(store: DocumentStore, operationId: string): Operation {
  return transitionOperation(store, operationId, ['reserved', 'active'], 'compensated', 'compensation');
}

// Explicit recovery (DECK-ARCH-004): the human reconciles an unsettled
// operation — confirm keeps its effects (owner acknowledges), clean records
// the cleanup decision. Neither guesses: no takeover, no timeout. The old
// owner is fenced afterwards by the owner-conditional updates above.
export function reconcileOperation(
  store: DocumentStore,
  operationId: string,
  action: 'confirm' | 'clean',
): Operation {
  if (action !== 'confirm' && action !== 'clean') {
    throw new DeckError(`reconcile action '${action}' is unknown — confirm or clean`, { operationId, action });
  }
  const row = store.db.select().from(operations).where(eq(operations.id, operationId)).get();
  if (row === undefined) throw new DeckError(`operation '${operationId}' not found`, { operationId });
  if (!UNSETTLED_STATES.includes(row.state)) {
    throw new DeckError(
      `operation '${operationId}' is ${row.state} — reconcile applies to unsettled operations only`,
      { operationId, state: row.state },
    );
  }
  const to: OperationState = action === 'confirm' ? 'completed' : 'compensated';
  const ts = nowIso();
  runTx(store.db, (tx) => {
    tx.update(operations)
      .set({ state: to, updatedAt: ts })
      .where(eq(operations.id, operationId))
      .run();
  });
  return { ...row, state: to, updatedAt: ts };
}

export function listUnsettledOperations(store: DocumentStore): Operation[] {
  return store.db
    .select()
    .from(operations)
    .where(inArray(operations.state, UNSETTLED_STATES))
    .all()
    .map(toOperation);
}

export function listOperations(store: DocumentStore): Operation[] {
  return store.db.select().from(operations).all().map(toOperation);
}

export function getOperation(store: DocumentStore, operationId: string): Operation | undefined {
  const row = store.db.select().from(operations).where(eq(operations.id, operationId)).get();
  return row === undefined ? undefined : toOperation(row);
}

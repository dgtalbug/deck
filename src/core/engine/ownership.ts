import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { DeckError } from '../board/errors.ts';
import { LeaseStillActiveError, UncertainEffectsError, WipLimitError } from '../board/errors.ts';
import { operations, providerOperations, type OperationRow } from '../board/schema.ts';
import { runTx, type DocumentStore, type Tx } from '../board/store.ts';

export type OperationKind = OperationRow['kind'];
export type OperationState = OperationRow['state'];

export const UNSETTLED_STATES: OperationState[] = ['reserved', 'active', 'recovery-required'];

export const ownerToken = `${process.pid}-${randomUUID()}`;

export const DEFAULT_LEASE_MS = 10 * 60 * 1000;

// Deterministic expiry in tests: an injectable clock, never persisted.
let clock: () => Date = () => new Date();

export function setOwnershipClockForTests(now: (() => Date) | undefined): void {
  clock = now ?? (() => new Date());
}

export function leaseDurationMs(store: DocumentStore): number {
  const minutes = (store as unknown as { leaseMinutes?: number }).leaseMinutes;
  return minutes !== undefined && Number.isFinite(minutes) && minutes > 0
    ? minutes * 60 * 1000
    : DEFAULT_LEASE_MS;
}

export function canonicalCheckout(projectPath: string): string {
  return realpathSync(projectPath);
}

export class OperationConflictError extends DeckError {
  constructor(message: string, details: Record<string, unknown>) {
    super(message, details);
  }
}

export class TakeoverLostError extends OperationConflictError {
  constructor(operationId: string) {
    super(
      `operation ${operationId} was taken over concurrently — exactly one recovery may win`,
      { operationId },
    );
  }
}

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
  leaseExpiresAt: string | null;
  fenceToken: number;
}

function toOperation(row: OperationRow): Operation {
  return { ...row };
}

function nowIso(): string {
  return new Date().toISOString();
}

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

export function reserveOperationInTx(
  tx: Tx,
  input: {
    cardId: string;
    kind: OperationKind;
    owner: string;
    checkout: string;
    expectLane?: string;
    wip?: { limit: number; activeCount: number; topCardId: string };
    leaseMs?: number;
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
  const leaseExpiresAt = new Date(clock().getTime() + (input.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
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
      leaseExpiresAt,
      fenceToken: 0,
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
    leaseExpiresAt,
    fenceToken: 0,
  };
}

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

export function completeOperation(store: DocumentStore, operationId: string): Operation {
  return transitionOperation(store, operationId, ['reserved', 'active'], 'completed', 'completion');
}

export function compensateOperation(store: DocumentStore, operationId: string): Operation {
  return transitionOperation(store, operationId, ['reserved', 'active'], 'compensated', 'compensation');
}

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
      .set({ state: to, updatedAt: ts, fenceToken: row.fenceToken + 1 })
      .where(eq(operations.id, operationId))
      .run();
  });
  return { ...row, state: to, updatedAt: ts, fenceToken: row.fenceToken + 1 };
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

// Lease renewal is owner- and fence-conditional: a stale owner (post-takeover)
// cannot extend a lease it no longer holds, and the fence observed by the
// caller must still match, so a concurrent takeover invalidates old renewals.
export function renewLease(store: DocumentStore, operationId: string, expectedFence: number): Operation {
  const ts = nowIso();
  const leaseExpiresAt = new Date(clock().getTime() + leaseDurationMs(store)).toISOString();
  let updated: Operation | undefined;
  runTx(store.db, (tx) => {
    const rows = tx
      .update(operations)
      .set({ leaseExpiresAt, updatedAt: ts })
      .where(
        and(
          eq(operations.id, operationId),
          eq(operations.owner, ownerToken),
          eq(operations.fenceToken, expectedFence),
          inArray(operations.state, ['reserved', 'active']),
        ),
      )
      .returning()
      .all();
    if (rows.length > 0) updated = toOperation(rows[0]!);
  });
  if (updated === undefined) {
    const row = store.db.select().from(operations).where(eq(operations.id, operationId)).get();
    throw new StaleOperationError(operationId, row?.cardId ?? 'unknown', 'lease renewal');
  }
  return updated;
}

export interface OperationHealth {
  operation: Operation;
  expired: boolean;
  msToExpiry: number | null;
}

// Renew before expiry ahead of long-running effects. Callers pass the fence
// they observed when the operation was reserved; a takeover in between makes
// this refuse instead of silently extending someone else's lease.
export function ensureLeaseFresh(store: DocumentStore, operation: Pick<Operation, 'id' | 'leaseExpiresAt' | 'fenceToken'>): Operation {
  if (operation.leaseExpiresAt === null) {
    throw new StaleOperationError(operation.id, 'unknown', 'lease check');
  }
  const remaining = new Date(operation.leaseExpiresAt).getTime() - clock().getTime();
  if (remaining > leaseDurationMs(store) / 2) {
    const current = getOperation(store, operation.id);
    if (current === undefined) throw new StaleOperationError(operation.id, 'unknown', 'lease check');
    return current;
  }
  return renewLease(store, operation.id, operation.fenceToken);
}

// Pure read: computes lease state without writing anything, so diagnostics
// and read models can surface expiry without side effects.
export function operationHealth(
  store: DocumentStore,
  options: { now?: Date } = {},
): OperationHealth[] {
  const now = options.now ?? clock();
  return listUnsettledOperations(store).map((operation) => {
    if (operation.leaseExpiresAt === null) {
      return { operation, expired: true, msToExpiry: null };
    }
    const msToExpiry = new Date(operation.leaseExpiresAt).getTime() - now.getTime();
    return { operation, expired: msToExpiry <= 0, msToExpiry };
  });
}

function uncertainEffects(store: DocumentStore, cardId: string): Array<{ kind: string; state: string; id: string }> {
  return store.db
    .select()
    .from(providerOperations)
    .where(and(eq(providerOperations.cardId, cardId), inArray(providerOperations.state, ['claimed', 'uncertain'])))
    .all()
    .map((row) => ({ kind: row.kind, state: row.state, id: row.id }));
}

// Explicit recovery after lease expiry. Expiry alone never permits takeover:
// the caller must reconcile owned effects first, and the fence advances
// atomically so concurrent takeovers cannot both win and the stale owner is
// fenced out of every later conditional transition.
export function recoverOperation(
  store: DocumentStore,
  operationId: string,
  action: 'takeover' | 'cancel',
): Operation {
  if (action !== 'takeover' && action !== 'cancel') {
    throw new DeckError(`recovery action '${action}' is unknown — takeover or cancel`, { operationId, action });
  }
  const row = store.db.select().from(operations).where(eq(operations.id, operationId)).get();
  if (row === undefined) throw new DeckError(`operation '${operationId}' not found`, { operationId });
  if (!UNSETTLED_STATES.includes(row.state)) {
    throw new DeckError(
      `operation '${operationId}' is ${row.state} — recovery applies to unsettled operations only`,
      { operationId, state: row.state },
    );
  }
  const now = clock();
  if (row.leaseExpiresAt !== null && row.state !== 'recovery-required') {
    const msToExpiry = new Date(row.leaseExpiresAt).getTime() - now.getTime();
    if (msToExpiry > 0) {
      throw new LeaseStillActiveError(operationId, row.leaseExpiresAt, msToExpiry);
    }
  }
  const effects = uncertainEffects(store, row.cardId);
  if (effects.length > 0) {
    throw new UncertainEffectsError(operationId, effects);
  }
  const ts = nowIso();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs(store)).toISOString();
  let updated: Operation | undefined;
  runTx(store.db, (tx) => {
    const set =
      action === 'takeover'
        ? { owner: ownerToken, fenceToken: row.fenceToken + 1, leaseExpiresAt, updatedAt: ts }
        : { state: 'compensated' as const, owner: ownerToken, fenceToken: row.fenceToken + 1, leaseExpiresAt: null, updatedAt: ts };
    const rows = tx
      .update(operations)
      .set(set)
      .where(and(eq(operations.id, operationId), eq(operations.fenceToken, row.fenceToken)))
      .returning()
      .all();
    if (rows.length > 0) updated = toOperation(rows[0]!);
  });
  if (updated === undefined) {
    throw new TakeoverLostError(operationId);
  }
  return updated;
}

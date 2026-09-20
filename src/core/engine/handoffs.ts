import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { DeckError, NotFoundError } from '../board/errors.ts';
import { cards, handoffs, operations, taskState, tasks, type HandoffRow } from '../board/schema.ts';
import { runTx, type DocumentStore, type Tx } from '../board/store.ts';
import { emitEvent } from '../events/outbox.ts';
import { readCheckpoint } from '../board/checkpoint.ts';
import { TaskOwnerMismatchError } from '../board/task-patches.ts';
import { evidenceBasisDigest } from './apply.ts';

export type HandoffState = HandoffRow['state'];

export interface Handoff {
  id: string;
  cardId: string;
  taskId: string;
  sender: string;
  recipient: string;
  scopeRevision: number;
  checkpointRevision: number;
  remainingWork: string | null;
  evidenceIds: string[];
  evidenceBasis: string | null;
  state: HandoffState;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface HandoffOfferInput {
  cardId: string;
  taskId: string;
  sender: string;
  recipient: string;
  remainingWork?: string | undefined;
  evidenceIds?: string[] | undefined;
}

function toHandoff(row: HandoffRow): Handoff {
  return {
    id: row.id,
    cardId: row.cardId,
    taskId: row.taskId,
    sender: row.sender,
    recipient: row.recipient,
    scopeRevision: row.scopeRevision,
    checkpointRevision: row.checkpointRevision,
    remainingWork: row.remainingWork,
    evidenceIds: row.evidenceIds === null ? [] : (JSON.parse(row.evidenceIds) as string[]),
    evidenceBasis: row.evidenceBasis,
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export class HandoffStateError extends DeckError {}

function checkpointRevisionOf(store: DocumentStore, cardId: string): number {
  const state = readCheckpoint(store.projectPath, cardId);
  return state.managed ? state.revision : 0;
}

function scopeRevisionOf(store: DocumentStore, cardId: string): number {
  const row = store.db.select({ revision: cards.scopeRevision }).from(cards).where(eq(cards.id, cardId)).get();
  return row?.revision ?? 0;
}

export function offerHandoff(store: DocumentStore, input: HandoffOfferInput): Handoff {
  if (input.sender === input.recipient) {
    throw new HandoffStateError(`handoff sender and recipient are both '${input.sender}' — name another owner`, {
      sender: input.sender,
    });
  }
  const scopeRevision = scopeRevisionOf(store, input.cardId);
  const checkpointRevision = checkpointRevisionOf(store, input.cardId);
  let offered: Handoff | undefined;
  runTx(store.db, (tx) => {
    const taskRow = tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.cardId, input.cardId), eq(tasks.id, input.taskId)))
      .get();
    if (taskRow === undefined) throw new NotFoundError('task', `${input.cardId}/${input.taskId}`);
    const stateRow = tx.select().from(taskState).where(eq(taskState.taskId, input.taskId)).get();
    if (stateRow === undefined || stateRow.owner === null) {
      throw new DeckError(
        `task ${input.taskId} on card ${input.cardId} has no assigned owner — assign it before offering a handoff`,
        { taskId: input.taskId, cardId: input.cardId },
      );
    }
    if (stateRow.cardId !== input.cardId) {
      throw new DeckError(
        `task ${input.taskId} belongs to card ${stateRow.cardId}, not ${input.cardId}`,
        { taskId: input.taskId, requestedCard: input.cardId, owningCard: stateRow.cardId },
      );
    }
    if (stateRow.owner !== input.sender) {
      throw new TaskOwnerMismatchError(input.taskId, input.sender, stateRow.owner);
    }
    const existing = tx
      .select()
      .from(handoffs)
      .where(
        and(
          eq(handoffs.taskId, input.taskId),
          eq(handoffs.sender, input.sender),
          eq(handoffs.recipient, input.recipient),
          eq(handoffs.state, 'offered'),
        ),
      )
      .get();
    if (existing !== undefined) {
      offered = toHandoff(existing);
      return;
    }
    const id = `ho-${randomUUID()}`;
    const ts = nowIso();
    const row: HandoffRow = {
      id,
      cardId: input.cardId,
      taskId: input.taskId,
      sender: input.sender,
      recipient: input.recipient,
      scopeRevision,
      checkpointRevision,
      remainingWork: input.remainingWork ?? null,
      evidenceIds: JSON.stringify(input.evidenceIds ?? []),
      evidenceBasis: evidenceBasisDigest(store, input.cardId),
      state: 'offered',
      createdAt: ts,
      updatedAt: ts,
      closedAt: null,
    };
    tx.insert(handoffs).values(row).run();
    emitHandoffEvent(tx, 'handoff.offered', row);
    offered = toHandoff(row);
  });
  return offered!;
}

export function getHandoff(store: DocumentStore, handoffId: string): Handoff {
  const row = store.db.select().from(handoffs).where(eq(handoffs.id, handoffId)).get();
  if (row === undefined) throw new NotFoundError('handoff', handoffId);
  return toHandoff(row);
}

export function listHandoffs(store: DocumentStore, filter?: { cardId?: string; state?: HandoffState }): Handoff[] {
  const conditions = [];
  if (filter?.cardId !== undefined) conditions.push(eq(handoffs.cardId, filter.cardId));
  if (filter?.state !== undefined) conditions.push(eq(handoffs.state, filter.state));
  const rows =
    conditions.length === 0
      ? store.db.select().from(handoffs).all()
      : store.db.select().from(handoffs).where(and(...conditions)).all();
  return rows.map(toHandoff);
}

export function cancelHandoff(store: DocumentStore, input: { handoffId: string; owner: string }): Handoff {
  let cancelled: Handoff | undefined;
  runTx(store.db, (tx) => {
    const row = tx.select().from(handoffs).where(eq(handoffs.id, input.handoffId)).get();
    if (row === undefined) throw new NotFoundError('handoff', input.handoffId);
    if (row.sender !== input.owner) {
      throw new TaskOwnerMismatchError(`handoff ${input.handoffId}`, input.owner, row.sender);
    }
    if (row.state !== 'offered') {
      throw new HandoffStateError(
        `handoff ${input.handoffId} is ${row.state} — only offered handoffs can be cancelled`,
        { handoffId: input.handoffId, state: row.state },
      );
    }
    const ts = nowIso();
    tx.update(handoffs).set({ state: 'cancelled', updatedAt: ts, closedAt: ts }).where(eq(handoffs.id, input.handoffId)).run();
    const updated: HandoffRow = { ...row, state: 'cancelled', updatedAt: ts, closedAt: ts };
    emitHandoffEvent(tx, 'handoff.cancelled', updated);
    cancelled = toHandoff(updated);
  });
  return cancelled!;
}

export function acceptHandoff(store: DocumentStore, input: { handoffId: string; recipient: string }): Handoff {
  let accepted: Handoff | undefined;
  runTx(store.db, (tx) => {
    const row = tx.select().from(handoffs).where(eq(handoffs.id, input.handoffId)).get();
    if (row === undefined) throw new NotFoundError('handoff', input.handoffId);
    if (row.state === 'accepted') {
      if (row.recipient !== input.recipient) {
        throw new TaskOwnerMismatchError(`handoff ${input.handoffId}`, input.recipient, row.recipient);
      }
      accepted = toHandoff(row);
      return;
    }
    if (row.state === 'cancelled') {
      throw new HandoffStateError(
        `handoff ${input.handoffId} was cancelled by ${row.sender} — ask for a new offer`,
        { handoffId: input.handoffId },
      );
    }
    if (row.recipient !== input.recipient) {
      throw new DeckError(
        `handoff ${input.handoffId} is offered to ${row.recipient}, not '${input.recipient}' — ` +
          `only the intended recipient can accept`,
        { handoffId: input.handoffId, recipient: row.recipient, caller: input.recipient },
      );
    }

    const cardRow = tx.select({ revision: cards.scopeRevision }).from(cards).where(eq(cards.id, row.cardId)).get();
    if (cardRow === undefined) throw new NotFoundError('card', row.cardId);
    if (cardRow.revision !== row.scopeRevision) {
      throw new HandoffStateError(
        `card ${row.cardId} scope changed since the offer (offer revision ${row.scopeRevision}, current ${cardRow.revision}) — ` +
          `the sender must re-offer against the current basis`,
        { handoffId: input.handoffId, offeredRevision: row.scopeRevision, currentRevision: cardRow.revision },
      );
    }
    const checkpoint = readCheckpoint(store.projectPath, row.cardId);
    const currentCheckpointRevision = checkpoint.managed ? checkpoint.revision : 0;
    if (currentCheckpointRevision !== row.checkpointRevision) {
      throw new HandoffStateError(
        `card ${row.cardId} checkpoint changed since the offer (offer revision ${row.checkpointRevision}, current ${currentCheckpointRevision}) — ` +
          `the sender must re-offer against the current basis`,
        { handoffId: input.handoffId, offeredRevision: row.checkpointRevision, currentRevision: currentCheckpointRevision },
      );
    }
    if (row.evidenceBasis !== null && row.evidenceBasis !== evidenceBasisDigest(store, row.cardId)) {
      throw new HandoffStateError(
        `card ${row.cardId} evidence state changed since the offer — the recipient must review the current evidence basis before accepting; ` +
          `the sender must re-offer`,
        { handoffId: input.handoffId },
      );
    }

    const unsettled = tx
      .select()
      .from(operations)
      .where(and(eq(operations.cardId, row.cardId), inArray(operations.state, ['reserved', 'active', 'recovery-required'])))
      .all();
    if (unsettled.length > 0) {
      const op = unsettled[0]!;
      throw new HandoffStateError(
        `card ${row.cardId} has unsettled engine operation ${op.id} (${op.kind}, state ${op.state}) — ` +
          `a database handoff cannot stop a running process; reconcile it first (deck ops reconcile)`,
        { handoffId: input.handoffId, operationId: op.id, operationState: op.state },
      );
    }

    const ts = nowIso();
    tx.update(handoffs).set({ state: 'accepted', updatedAt: ts, closedAt: ts }).where(eq(handoffs.id, input.handoffId)).run();
    const stateRow = tx.select().from(taskState).where(eq(taskState.taskId, row.taskId)).get();
    if (stateRow === undefined) {
      tx.insert(taskState)
        .values({ taskId: row.taskId, cardId: row.cardId, revision: 2, owner: input.recipient, assignedAt: ts, updatedAt: ts })
        .run();
    } else {
      tx.update(taskState)
        .set({ owner: input.recipient, revision: stateRow.revision + 1, assignedAt: ts, updatedAt: ts })
        .where(eq(taskState.taskId, row.taskId))
        .run();
    }
    const updated: HandoffRow = { ...row, state: 'accepted', updatedAt: ts, closedAt: ts };
    emitHandoffEvent(tx, 'handoff.accepted', updated);
    accepted = toHandoff(updated);
  });
  return accepted!;
}

function emitHandoffEvent(
  tx: Tx,
  type: 'handoff.offered' | 'handoff.accepted' | 'handoff.cancelled',
  row: HandoffRow,
): void {
  emitEvent(tx, type, {
    id: row.cardId,
    handoffId: row.id,
    taskId: row.taskId,
    sender: row.sender,
    recipient: row.recipient,
    state: row.state,
  });
}

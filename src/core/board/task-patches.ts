import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DeckError, NotFoundError, StaleWriterError } from './errors.ts';
import { emitEvent } from '../events/outbox.ts';
import { runTx, type DocumentStore, type Tx } from './store.ts';
import { taskPatches, taskState, tasks, type TaskStateRow } from './schema.ts';

// Tasks start their delivery state at revision 1 with no owner. Seeding rides
// the mutation that creates the task rows, never a later read or open.
export function seedTaskState(exec: Tx, cardId: string): void {
  exec.run(
    sql`INSERT OR IGNORE INTO task_state (task_id, card_id, revision, owner, assigned_at, updated_at)
        SELECT t.id, t.card_id, 1, NULL, NULL, ${new Date().toISOString()}
        FROM tasks t WHERE t.card_id = ${cardId}`,
  );
}

export interface TaskAssignment {
  taskId: string;
  cardId: string;
  revision: number;
  owner: string | null;
  assignedAt: string | null;
}

export interface TaskPatchInput {
  cardId: string;
  taskId: string;
  expectedRevision: number;
  owner: string;
  commandId: string;
  done: boolean;
}

export interface TaskPatchResult {
  taskId: string;
  cardId: string;
  revision: number;
  done: boolean;
  duplicate: boolean;
}

export class TaskNotAssignedError extends DeckError {
  constructor(taskId: string, cardId: string) {
    super(
      `task ${taskId} on card ${cardId} has no assigned owner — assign it before cooperative edits`,
      { taskId, cardId },
    );
  }
}

export class TaskOwnerMismatchError extends DeckError {
  constructor(taskId: string, owner: string, currentOwner: string | null) {
    super(
      `task ${taskId} is ${currentOwner === null ? 'unassigned' : `assigned to ${currentOwner}`} — ` +
        `writer '${owner}' is not the current owner`,
      { taskId, owner, currentOwner },
    );
  }
}

export class TaskCardMismatchError extends DeckError {
  constructor(taskId: string, requestedCard: string, owningCard: string) {
    super(
      `task ${taskId} belongs to card ${owningCard}, not ${requestedCard} — ` +
        `task ids are unique per board; reference the owning card`,
      { taskId, requestedCard, owningCard },
    );
  }
}

export class DuplicateCommandConflictError extends DeckError {
  constructor(commandId: string) {
    super(
      `command '${commandId}' was already recorded with a different payload — ` +
        `use a new command id for a different change`,
      { commandId },
    );
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function getTaskAssignment(store: DocumentStore, cardId: string, taskId: string): TaskAssignment {
  const row = store.db
    .select()
    .from(taskState)
    .where(and(eq(taskState.taskId, taskId), eq(taskState.cardId, cardId)))
    .get();
  if (row === undefined) {
    const exists = store.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.cardId, cardId), eq(tasks.id, taskId)))
      .get();
    if (exists === undefined) throw new NotFoundError('task', `${cardId}/${taskId}`);
    return { taskId, cardId, revision: 1, owner: null, assignedAt: null };
  }
  return { taskId: row.taskId, cardId: row.cardId, revision: row.revision, owner: row.owner, assignedAt: row.assignedAt };
}

export function assignTask(
  store: DocumentStore,
  input: { cardId: string; taskId: string; owner: string; by: string },
): TaskAssignment {
  let result: TaskAssignment | undefined;
  runTx(store.db, (tx) => {
    const taskRow = tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.cardId, input.cardId), eq(tasks.id, input.taskId)))
      .get();
    if (taskRow === undefined) throw new NotFoundError('task', `${input.cardId}/${input.taskId}`);
    const ts = nowIso();
    const existing = tx
      .select()
      .from(taskState)
      .where(and(eq(taskState.cardId, input.cardId), eq(taskState.taskId, input.taskId)))
      .get();
    if (existing === undefined) {
      tx.insert(taskState)
        .values({ taskId: input.taskId, cardId: input.cardId, revision: 1, owner: input.owner, assignedAt: ts, updatedAt: ts })
        .onConflictDoUpdate({
          target: [taskState.cardId, taskState.taskId],
          set: { owner: input.owner, assignedAt: ts, updatedAt: ts },
        })
        .run();
      result = { taskId: input.taskId, cardId: input.cardId, revision: 1, owner: input.owner, assignedAt: ts };
    } else {
      const revision = existing.revision + 1;
      tx.update(taskState)
        .set({ owner: input.owner, assignedAt: ts, updatedAt: ts, revision })
        .where(and(eq(taskState.cardId, input.cardId), eq(taskState.taskId, input.taskId)))
        .run();
      result = { taskId: input.taskId, cardId: input.cardId, revision, owner: input.owner, assignedAt: ts };
    }
    emitEvent(tx, 'task.assigned', {
      id: input.cardId,
      taskId: input.taskId,
      owner: input.owner,
      by: input.by,
    });
  });
  return result!;
}

function payloadDigest(input: TaskPatchInput): string {
  return createHash('sha256')
    .update(`${input.cardId}\n${input.taskId}\n${input.expectedRevision}\n${input.owner}\n${input.done}`)
    .digest('hex');
}

export function applyTaskPatch(store: DocumentStore, input: TaskPatchInput): TaskPatchResult {
  const digest = payloadDigest(input);
  let result: TaskPatchResult | undefined;
  runTx(store.db, (tx) => {
    const prior = tx.select().from(taskPatches).where(eq(taskPatches.commandId, input.commandId)).get();
    if (prior !== undefined) {
      if (prior.payloadDigest !== digest) throw new DuplicateCommandConflictError(input.commandId);
      const stored = JSON.parse(prior.result) as TaskPatchResult;
      result = { ...stored, duplicate: true };
      return;
    }

    const taskRow = tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.cardId, input.cardId), eq(tasks.id, input.taskId)))
      .get();
    if (taskRow === undefined) {
      throw new NotFoundError('task', `${input.cardId}/${input.taskId}`);
    }

    const stateRow = tx
      .select()
      .from(taskState)
      .where(and(eq(taskState.cardId, input.cardId), eq(taskState.taskId, input.taskId)))
      .get() as TaskStateRow | undefined;
    const currentRevision = stateRow?.revision ?? 1;
    const currentOwner = stateRow?.owner ?? null;
    if (currentOwner === null) throw new TaskNotAssignedError(input.taskId, input.cardId);
    if (currentOwner !== input.owner) throw new TaskOwnerMismatchError(input.taskId, input.owner, currentOwner);
    if (currentRevision !== input.expectedRevision) {
      throw new StaleWriterError(`task ${input.taskId}`, input.expectedRevision, currentRevision);
    }

    const revision = currentRevision + 1;
    const ts = nowIso();
    tx.update(tasks).set({ done: input.done }).where(and(eq(tasks.cardId, input.cardId), eq(tasks.id, input.taskId))).run();
    if (stateRow === undefined) {
      tx.insert(taskState)
        .values({ taskId: input.taskId, cardId: input.cardId, revision, owner: input.owner, assignedAt: ts, updatedAt: ts })
        .onConflictDoUpdate({
          target: [taskState.cardId, taskState.taskId],
          set: { revision, updatedAt: ts },
        })
        .run();
    } else {
      tx.update(taskState)
        .set({ revision, updatedAt: ts })
        .where(and(eq(taskState.cardId, input.cardId), eq(taskState.taskId, input.taskId)))
        .run();
    }

    const outcome: TaskPatchResult = {
      taskId: input.taskId,
      cardId: input.cardId,
      revision,
      done: input.done,
      duplicate: false,
    };
    tx.insert(taskPatches)
      .values({
        commandId: input.commandId,
        cardId: input.cardId,
        taskId: input.taskId,
        owner: input.owner,
        expectedRevision: input.expectedRevision,
        payloadDigest: digest,
        result: JSON.stringify(outcome),
        createdAt: ts,
      })
      .run();
    emitEvent(tx, 'task.patched', {
      id: input.cardId,
      taskId: input.taskId,
      owner: input.owner,
      done: input.done,
      revision,
      commandId: input.commandId,
    });
    result = outcome;
  });
  return result!;
}

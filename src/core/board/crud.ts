import { and, eq, notInArray } from 'drizzle-orm';
import { DeckError, EngineOwnedError, NotFoundError, StaleWriterError } from './errors.ts';
import { assertGroomReady, materializeSpec, sectionLabels } from './groom.ts';
import { getSpecType } from './types-registry.ts';
import { cards, issueMap, publishQueue, specs, storyDeps, taskState, tasks } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';
import type { Card, GroomProposal, Lane, VerbItem } from './types.ts';
import { emitEvent } from '../events/outbox.ts';
import { recordSpecVersion, renderCardSpec, enqueuePublish } from './specstore.ts';
import {
  applyScopeEdit,
  acceptedRevision,
  currentAcceptedSnapshot,
  currentScopeRevision,
  deterministicRequirementIds,
  recordAcceptedRevision,
  scopeClassification,
  scopeCriteria,
  StaleBasisError,
  type AcceptedScopeSnapshot,
  type ScopeOperation,
} from './accepted-scope.ts';
import { applyCriterionOps, applyTaskOps, recordScopeRevision } from './scope.ts';
import { seedTaskState } from './task-patches.ts';

const MANUAL_LANES: ReadonlySet<Lane> = new Set(['todo', 'groomed']);

function nowIso(): string {
  return new Date().toISOString();
}

function assertManualLane(id: string, lane: Lane, action: string): void {
  if (!MANUAL_LANES.has(lane)) throw new EngineOwnedError(id, lane, action);
}

export function updateCard(store: DocumentStore, id: string, input: { title: string }): Card {
  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, id)).get();
    if (!row) throw new NotFoundError('card', id);
    assertManualLane(id, row.lane, 'edit');
    tx.update(cards).set({ title: input.title, updatedAt: nowIso() }).where(eq(cards.id, id)).run();
    emitEvent(tx, 'card.updated', { id, lane: row.lane });
  });
  return store.getCard(id);
}

export function deleteCard(store: DocumentStore, id: string): void {
  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, id)).get();
    if (!row) throw new NotFoundError('card', id);
    assertManualLane(id, row.lane, 'delete');
    if (row.type === 'epic') {
      tx.update(cards).set({ epicId: null, updatedAt: new Date().toISOString() }).where(eq(cards.epicId, id)).run();
    }
    const dependents = tx.select().from(storyDeps).where(eq(storyDeps.dependsOn, id)).all();
    if (dependents.length > 0) {
      throw new DeckError(
        `card ${id} is a prerequisite of ${dependents.map((edge) => edge.cardId).join(', ')} — ` +
          `remove those dependency edges first (deck deps <card> remove ${id})`,
        { cardId: id, dependents: dependents.map((edge) => edge.cardId) },
      );
    }
    tx.delete(storyDeps).where(eq(storyDeps.cardId, id)).run();
    tx.delete(tasks).where(eq(tasks.cardId, id)).run();
    tx.delete(issueMap).where(eq(issueMap.cardId, id)).run();
    tx.delete(publishQueue).where(eq(publishQueue.cardId, id)).run();
    tx.delete(specs).where(eq(specs.cardId, id)).run();
    tx.delete(cards).where(eq(cards.id, id)).run();
    emitEvent(tx, 'card.deleted', { id, lane: row.lane });
  });
}

// Translate a groom proposal into explicit accepted-scope operations against
// the current accepted snapshot. Title-only re-grooms map onto keep/reorder
// operations; identity-bearing proposals map their task/criterion ops by id.
function groomScopeOperations(current: AcceptedScopeSnapshot, proposal: GroomProposal): ScopeOperation[] {
  const operations: ScopeOperation[] = [
    { kind: 'story', title: proposal.refinedTitle, verb: proposal.proposedVerb },
  ];

  const desiredTitles = proposal.specDeltas.map((delta, index) => delta.requirement.trim() || `untitled-${index}`);
  const desiredIds = deterministicRequirementIds(desiredTitles);
  const requirementById = new Map(current.requirements.map((item) => [item.id, item]));
  desiredTitles.forEach((title, index) => {
    const id = desiredIds[index]!;
    const existing = requirementById.get(id);
    if (
      existing === undefined ||
      existing.title !== title ||
      existing.body !== proposal.specDeltas[index]!.text
    ) {
      operations.push({ kind: 'requirement', op: 'add', title, body: proposal.specDeltas[index]!.text });
    }
  });
  const desiredIdSet = new Set(desiredIds);
  for (const requirement of current.requirements) {
    if (!desiredIdSet.has(requirement.id)) {
      operations.push({ kind: 'requirement', op: 'remove', id: requirement.id });
    }
  }

  const activeCriteria = current.criteria.filter((item) => item.state === 'active');
  const criterionByTitle = new Map<string, { id: string }>();
  for (const criterion of activeCriteria) {
    if (criterionByTitle.has(criterion.title)) {
      throw new DeckError(
        `criterion title '${criterion.title}' is ambiguous on this card — address criteria by id through scope edits`,
        { title: criterion.title },
      );
    }
    criterionByTitle.set(criterion.title, criterion);
  }
  for (const op of proposal.criterionOps ?? []) {
    const target = criterionByTitle.get(op.title);
    if (target === undefined) {
      throw new DeckError(
        `criterion '${op.title}' is not an active criterion of this card — list current criteria before editing`,
        { title: op.title },
      );
    }
    if (op.op === 'keep') {
      operations.push({ kind: 'criterion', op: 'keep', id: target.id });
    } else if (op.op === 'classify') {
      // classify replaces the (possibly unclassified) id with the deterministic one
      operations.push({ kind: 'criterion', op: 'remove', id: target.id });
      operations.push({ kind: 'criterion', op: 'add', title: op.title });
    } else if (op.op === 'remove') {
      operations.push({ kind: 'criterion', op: 'remove', id: target.id });
    } else {
      operations.push({ kind: 'criterion', op: 'supersede', id: target.id, replacement: op.replacement });
    }
  }
  const activeDeltaTitles = [...new Set(proposal.specDeltas.map((delta) => delta.requirement.trim()).filter(Boolean))];
  for (const title of activeDeltaTitles) {
    if (!criterionByTitle.has(title)) operations.push({ kind: 'criterion', op: 'add', title });
  }

  if (proposal.taskOps !== undefined) {
    const planById = new Map(current.plan.filter((item) => item.state === 'active').map((item) => [item.id, item]));
    const addressed = new Set<string>();
    for (const op of proposal.taskOps) {
      if (op.op === 'add') {
        operations.push({ kind: 'task', op: 'add', title: op.title });
        continue;
      }
      if (!planById.has(op.id)) {
        throw new DeckError(`task id '${op.id}' is not a task of this card — list current tasks first`, { id: op.id });
      }
      addressed.add(op.id);
      if (op.op === 'keep') operations.push({ kind: 'task', op: 'keep', id: op.id });
      else if (op.op === 'rename') operations.push({ kind: 'task', op: 'rename', id: op.id, title: op.title });
      else operations.push({ kind: 'task', op: 'remove', id: op.id });
    }
    for (const [id, item] of planById) {
      if (!addressed.has(id)) {
        throw new DeckError(
          `task '${item.title}' (${id}) is missing from taskOps — keep, rename, or remove it explicitly`,
          { id, title: item.title },
        );
      }
    }
  } else {
    // Title-only re-groom: unchanged title sets keep ids (reordering is an
    // explicit, identity-preserving operation); changed sets must use taskOps.
    const currentTitles = current.plan.filter((item) => item.state === 'active').map((item) => item.title);
    const proposedTitles = proposal.tasks;
    const sameSet =
      currentTitles.length === proposedTitles.length &&
      [...currentTitles].sort().join('\u0000') === [...proposedTitles].sort().join('\u0000');
    if (!sameSet) {
      throw new DeckError(
        'task titles changed in a title-only re-groom — identity cannot be guessed; ' +
          'resubmit with taskOps (keep/rename/add/remove by task id)',
        { existing: currentTitles, proposed: proposedTitles },
      );
    }
    const idByTitle = new Map(current.plan.filter((item) => item.state === 'active').map((item) => [item.title, item.id]));
    const order = proposedTitles.map((title) => idByTitle.get(title)!);
    if (order.join('\u0000') !== currentTitles.join('\u0000')) {
      operations.push({ kind: 'task', op: 'reorder', order });
    }
  }

  return operations;
}

// Rebuild the visible task projection from an accepted snapshot. Progress
// (done, addedByVerify) survives by id; ids that left the accepted plan have
// no addressable progress anymore, so their task_state rows are dropped.
export function rebuildTasksFromSnapshot(
  tx: Parameters<Parameters<typeof runTx>[1]>[0],
  cardId: string,
  snapshot: AcceptedScopeSnapshot,
  flags: { doneById?: ReadonlyMap<string, boolean>; addedByVerifyById?: ReadonlyMap<string, boolean> } = {},
): void {
  const priorRows = tx.select().from(tasks).where(eq(tasks.cardId, cardId)).all();
  const priorDone = new Map(priorRows.map((row) => [row.id, row.done]));
  const priorVerify = new Map(priorRows.map((row) => [row.id, row.addedByVerify]));
  const doneById = flags.doneById ?? priorDone;
  tx.delete(tasks).where(eq(tasks.cardId, cardId)).run();
  const activePlan = snapshot.plan.filter((item) => item.state === 'active');
  const activeIds = activePlan.map((item) => item.id);
  if (activeIds.length === 0) {
    tx.delete(taskState).where(eq(taskState.cardId, cardId)).run();
  } else {
    tx.delete(taskState)
      .where(and(eq(taskState.cardId, cardId), notInArray(taskState.taskId, activeIds)))
      .run();
  }
  for (const [index, item] of activePlan.entries()) {
    const addedByVerify = flags.addedByVerifyById?.get(item.id) ?? priorVerify.get(item.id) ?? null;
    tx.insert(tasks)
      .values({ cardId, idx: index, id: item.id, title: item.title, done: doneById.get(item.id) === true, addedByVerify })
      .run();
  }
  seedTaskState(tx, cardId);
}

export function updateGroom(store: DocumentStore, id: string, proposal: GroomProposal): VerbItem {
  const before = store.getVerbItem(id);
  assertManualLane(id, before.lane, 'edit groom');
  assertGroomReady(store, proposal, `re-groom of ${id}`);
  const identityEdit = proposal.taskOps !== undefined || proposal.criterionOps !== undefined;
  const classification = scopeClassification(store.db, id);
  const basis = currentScopeRevision(store.db, id);
  const doneById = new Map(before.tasks.map((task) => [task.id, task.done]));

  if (classification === 'quarantined') {
    throw new DeckError(
      `card ${id} has quarantined scope identity — resolve the quarantine diagnostics before editing scope`,
      { cardId: id, classification },
    );
  }

  // Stale basis refuses before any mapping: an editor holding an older basis
  // cannot address tasks it has never seen, so coverage errors would mask the
  // actual conflict. The preview maps what it can and names the rest.
  if (proposal.expectedRevision !== undefined && proposal.expectedRevision !== basis) {
    if (classification !== 'accepted') {
      throw new StaleWriterError(`scope of ${id}`, proposal.expectedRevision, basis);
    }
    const snapshot = currentAcceptedSnapshot(store.db, id)!;
    const revisionRow = acceptedRevision(store.db, id)!;
    const planIds = new Set(snapshot.plan.filter((item) => item.state === 'active').map((item) => item.id));
    const attempted: ScopeOperation[] = [{ kind: 'story', title: proposal.refinedTitle, verb: proposal.proposedVerb }];
    const conflicts: string[] = [];
    const safeNoOps: ScopeOperation[] = [];
    for (const op of proposal.taskOps ?? []) {
      if (op.op === 'add') {
        attempted.push({ kind: 'task', op: 'add', title: op.title });
        continue;
      }
      if (!planIds.has(op.id)) {
        conflicts.push(`task '${op.id}' is not in the current accepted plan (basis moved)`);
        continue;
      }
      const mapped: ScopeOperation =
        op.op === 'keep' ? { kind: 'task', op: 'keep', id: op.id }
        : op.op === 'rename' ? { kind: 'task', op: 'rename', id: op.id, title: op.title }
        : { kind: 'task', op: 'remove', id: op.id };
      attempted.push(mapped);
      if (op.op === 'keep') safeNoOps.push(mapped);
    }
    throw new StaleBasisError(id, proposal.expectedRevision, basis, {
      current: { cardId: id, revision: basis, revisionId: revisionRow.revisionId, contentDigest: revisionRow.contentDigest },
      attempted,
      conflicts,
      safeNoOps,
    });
  }

  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, id)).get();
    if (!row) throw new NotFoundError('card', id);
    assertManualLane(id, row.lane, 'edit groom');
    if (currentScopeRevision(tx, id) !== basis) {
      throw new StaleWriterError(`scope of ${id}`, basis, currentScopeRevision(tx, id));
    }

    if (classification === 'accepted') {
      const current = currentAcceptedSnapshot(tx, id)!;
      const operations = groomScopeOperations(current, proposal);
      applyScopeEdit(tx, id, { operations, actor: 'regroom', basisRevision: proposal.expectedRevision ?? basis });
      const next = currentAcceptedSnapshot(tx, id)!;
      rebuildTasksFromSnapshot(tx, id, next, { doneById });
    } else if (identityEdit) {
      // Unclassified card plus an identity-bearing edit: classify the existing
      // rows as an adopted revision first, then apply the edit on top of it.
      recordAcceptedRevision(
        tx,
        id,
        {
          verb: before.verb,
          title: before.title,
          requirements: [],
          criteria: scopeCriteria(tx, id).map((criterion) => ({
            id: criterion.id,
            title: criterion.title,
            state: criterion.state === 'active' || criterion.state === 'removed' || criterion.state === 'superseded'
              ? criterion.state
              : 'active',
          })),
          plan: before.tasks.map((task, index) => ({ id: task.id, position: index, title: task.title, state: 'active' as const })),
        },
        [{ kind: 'adopt', source: 'groom-classify', requirements: 'none' }],
        { actor: 'regroom' },
      );
      const current = currentAcceptedSnapshot(tx, id)!;
      const operations = groomScopeOperations(current, proposal);
      applyScopeEdit(tx, id, { operations, actor: 'regroom', basisRevision: currentScopeRevision(tx, id) });
      const next = currentAcceptedSnapshot(tx, id)!;
      rebuildTasksFromSnapshot(tx, id, next, { doneById });
    } else {
      // Unclassified card, title-only: legacy ledger behavior — no accepted
      // identity is invented, criteria stay unclassified until reviewed.
      const nextTasks = applyTaskOps(before.tasks, proposal.tasks, proposal.taskOps);
      const existingCriteria = scopeCriteria(tx, id);
      const activeTitles = [...new Set(proposal.specDeltas.map((delta) => delta.requirement.trim()).filter(Boolean))];
      applyCriterionOps(tx, id, currentScopeRevision(tx, id) + 1, existingCriteria, activeTitles, proposal.criterionOps, false);
      tx.delete(tasks).where(eq(tasks.cardId, id)).run();
      for (const [index, task] of nextTasks.entries()) {
        tx.insert(tasks)
          .values({ cardId: id, idx: index, id: task.id, title: task.title, done: doneById.get(task.id) === true })
          .run();
      }
      seedTaskState(tx, id);
      recordScopeRevision(
        tx,
        id,
        {
          verb: proposal.proposedVerb,
          title: proposal.refinedTitle,
          tasks: nextTasks,
          criteria: scopeCriteria(tx, id).map((criterion) => ({ ...criterion })),
        },
        ['no-op/reorder re-groom'],
      );
    }

    tx.update(cards)
      .set({
        title: proposal.refinedTitle,
        verb: proposal.proposedVerb,
        research: JSON.stringify(proposal.research),
        updatedAt: nowIso(),
      })
      .where(eq(cards.id, id))
      .run();
    emitEvent(tx, 'card.updated', { id, lane: row.lane });
  });
  const item = store.getVerbItem(id);
  const doneByTitle = new Map(before.tasks.map((task) => [task.title, task.done]));
  materializeSpec(
    store.projectPath,
    item.specPath,
    proposal,
    doneByTitle,
    sectionLabels(getSpecType(store, proposal.proposedVerb)),
  );
  const version = recordSpecVersion(store, id, renderCardSpec(store, item));
  enqueuePublish(store, id, version.checksum);
  return item;
}

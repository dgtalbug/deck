import { asc, eq } from 'drizzle-orm';
import { DeckError, EngineOwnedError, NotFoundError, StaleWriterError } from './errors.ts';
import { assertGroomReady, materializeSpec, sectionLabels } from './groom.ts';
import { getSpecType, sectionGate } from './types-registry.ts';
import { cards, issueMap, publishQueue, specs, storyDeps, tasks } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';
import type { Card, GroomProposal, Lane, VerbItem } from './types.ts';
import { emitEvent } from '../events/outbox.ts';
import { recordSpecVersion, renderCardSpec, enqueuePublish } from './specstore.ts';
import { applyCriterionOps, applyTaskOps, currentScopeRevision, recordScopeRevision, scopeCriteria } from './scope.ts';

// v0.2.0 card CRUD for the human-owned lanes: rename, hard delete, and
// groom-content re-edit. Engine lanes (active/verify/done) refuse every
// write here — EngineOwnedError, not LaneViolation, because nothing moves.

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

// Hard delete: card + task rows, positions left gapped (midpoint scheme
// tolerates holes; reorder renumbers on precision collapse, not deletion).
export function deleteCard(store: DocumentStore, id: string): void {
  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, id)).get();
    if (!row) throw new NotFoundError('card', id);
    assertManualLane(id, row.lane, 'delete');
    // Deleting an epic detaches its stories — children survive parentless.
    if (row.type === 'epic') {
      tx.update(cards).set({ epicId: null, updatedAt: new Date().toISOString() }).where(eq(cards.epicId, id)).run();
    }
    // E03 DECK-ARCH-016: a referenced prerequisite refuses deletion until the
    // dependency edges are explicitly removed — blockers never cascade away.
    const dependents = tx.select().from(storyDeps).where(eq(storyDeps.dependsOn, id)).all();
    if (dependents.length > 0) {
      throw new DeckError(
        `card ${id} is a prerequisite of ${dependents.map((edge) => edge.cardId).join(', ')} — ` +
          `remove those dependency edges first (deck deps <card> remove ${id})`,
        { cardId: id, dependents: dependents.map((edge) => edge.cardId) },
      );
    }
    tx.delete(storyDeps).where(eq(storyDeps.cardId, id)).run(); // outgoing edges die with the card
    tx.delete(tasks).where(eq(tasks.cardId, id)).run();
    // Cascade the card's derived rows too — a surviving issue_map/publish_queue/
    // specs row would make deck sync's drift loop crash on the dead card id
    // (getCard throws NotFoundError). The GitHub issue itself stays open:
    // delete means "forget the card", and whoever deletes closes the issue.
    tx.delete(issueMap).where(eq(issueMap.cardId, id)).run();
    tx.delete(publishQueue).where(eq(publishQueue.cardId, id)).run();
    tx.delete(specs).where(eq(specs.cardId, id)).run();
    tx.delete(cards).where(eq(cards.id, id)).run();
    emitEvent(tx, 'card.deleted', { id, lane: row.lane });
  });
}

// Re-edit an already-groomed verb item (E03 DECK-ARCH-011): specPath stays
// (stable engine references, no orphan dirs on verb change). Task and
// criterion identities survive: the shared validator (DECK-ARCH-008) runs
// first, then edits apply through explicit identity-bearing operations.
// Title-only legacy payloads remain readable — no-op/reorder keeps ids — but
// ambiguous title changes refuse instead of guessing. `expectedRevision`
// refuses a stale writer before anything is written.
export function updateGroom(store: DocumentStore, id: string, proposal: GroomProposal): VerbItem {
  const before = store.getVerbItem(id); // 404 when the id is not a verb item
  assertManualLane(id, before.lane, 'edit groom');
  // Same proportional readiness policy as initial groom (DECK-ARCH-008) —
  // one validator, refusal before DB/Markdown/publish effects.
  assertGroomReady(store, proposal, `re-groom of ${id}`);
  // Stale-writer refusal: identity edits carry the revision they were read at.
  const identityEdit = proposal.taskOps !== undefined || proposal.criterionOps !== undefined;
  if (proposal.expectedRevision !== undefined) {
    const current = currentScopeRevision(store.db, id);
    if (proposal.expectedRevision !== current) {
      throw new StaleWriterError(`scope of ${id}`, proposal.expectedRevision, current);
    }
  }
  const doneById = new Map(before.tasks.map((task) => [task.id, task.done]));
  const reviewed = identityEdit; // initial groom already classified; legacy cards classify on a reviewed edit
  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, id)).get();
    if (!row) throw new NotFoundError('card', id);
    assertManualLane(id, row.lane, 'edit groom');
    // Serialize the identity read with the write: the ops were computed
    // against `before`, so the rows must still match inside the transaction.
    const fresh = tx.select().from(tasks).where(eq(tasks.cardId, id)).orderBy(asc(tasks.idx)).all();
    if (fresh.length !== before.tasks.length || fresh.some((task, index) => task.id !== before.tasks[index]!.id)) {
      throw new StaleWriterError(`tasks of ${id}`, before.tasks.length, fresh.length);
    }
    const nextTasks = applyTaskOps(before.tasks, proposal.tasks, proposal.taskOps);
    const existingCriteria = scopeCriteria(tx, id);
    const activeTitles = [...new Set(proposal.specDeltas.map((delta) => delta.requirement.trim()).filter(Boolean))];
    const criteria = applyCriterionOps(tx, id, currentScopeRevision(tx, id) + 1, existingCriteria, activeTitles, proposal.criterionOps, reviewed);
    tx.delete(tasks).where(eq(tasks.cardId, id)).run();
    for (const [index, task] of nextTasks.entries()) {
      tx.insert(tasks)
        .values({ cardId: id, idx: index, id: task.id, title: task.title, done: doneById.get(task.id) === true })
        .run();
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
    recordScopeRevision(
      tx,
      id,
      { verb: proposal.proposedVerb, title: proposal.refinedTitle, tasks: nextTasks, criteria },
      identityEdit ? ['identity-bearing re-groom'] : ['no-op/reorder re-groom'],
    );
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
  enqueuePublish(store, id, version.checksum); // draft body refresh on next flush
  return item;
}

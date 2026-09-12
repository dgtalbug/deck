import { eq } from 'drizzle-orm';
import { EngineOwnedError, NotFoundError } from './errors.ts';
import { newTaskId } from './ids.ts';
import { materializeSpec } from './groom.ts';
import { cards, issueMap, publishQueue, specs, tasks } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';
import type { Card, GroomProposal, Lane, VerbItem } from './types.ts';
import { emitEvent } from '../events/outbox.ts';
import { recordSpecVersion, renderCardSpec } from './specstore.ts';

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

// Re-edit an already-groomed verb item: title/verb/research/tasks replace,
// specPath stays (stable engine references, no orphan dirs on verb change).
// Task done-state survives by title match — a reworded task is new work.
export function updateGroom(store: DocumentStore, id: string, proposal: GroomProposal): VerbItem {
  const before = store.getVerbItem(id); // 404 when the id is not a verb item
  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, id)).get();
    if (!row) throw new NotFoundError('card', id);
    assertManualLane(id, row.lane, 'edit groom');
    const doneByTitle = new Map(before.tasks.map((task) => [task.title, task.done]));
    tx.update(cards)
      .set({
        title: proposal.refinedTitle,
        verb: proposal.proposedVerb,
        research: JSON.stringify(proposal.research),
        updatedAt: nowIso(),
      })
      .where(eq(cards.id, id))
      .run();
    tx.delete(tasks).where(eq(tasks.cardId, id)).run();
    for (const [index, title] of proposal.tasks.entries()) {
      tx.insert(tasks)
        .values({ cardId: id, idx: index, id: newTaskId(), title, done: doneByTitle.get(title) === true })
        .run();
    }
    emitEvent(tx, 'card.updated', { id, lane: row.lane });
  });
  const item = store.getVerbItem(id);
  const doneByTitle = new Map(before.tasks.map((task) => [task.title, task.done]));
  materializeSpec(store.projectPath, item.specPath, proposal, doneByTitle);
  recordSpecVersion(store, id, renderCardSpec(store, item));
  return item;
}

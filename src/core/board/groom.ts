import { eq } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DeckError, NotFoundError } from './errors.ts';
import { newTaskId } from './ids.ts';
import { endPosition } from './positions.ts';
import { cards, tasks } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';
import type { GroomProposal, Note, Tweak, VerbItem } from './types.ts';
import { emitEvent } from '../events/outbox.ts';
import { assertUnderWip } from './lanes.ts';
import { recordSpecVersion, renderCardSpec } from './specstore.ts';

function nowIso(): string {
  return new Date().toISOString();
}

// On accept, the spec directory exists with a real checklist so the
// tasks-read-from-spec contract has a source from day one. Re-edits pass a
// doneByTitle snapshot so surviving tasks keep their checkmarks in tasks.md
// (next's digest reads the file, not the DB).
export function materializeSpec(
  projectPath: string,
  specPath: string,
  proposal: GroomProposal,
  doneByTitle: ReadonlyMap<string, boolean> = new Map(),
): void {
  const dir = join(projectPath, specPath);
  mkdirSync(dir, { recursive: true });
  const checklist = proposal.tasks.map((task) => `- [${doneByTitle.get(task) === true ? 'x' : ' '}] ${task}`).join('\n');
  Bun.write(join(dir, 'tasks.md'), `${checklist}\n`);
  const deltas = proposal.specDeltas
    .map((delta) => `### ${delta.op}: ${delta.requirement}\n${delta.text}\n`)
    .join('\n');
  const spec = `# ${proposal.refinedTitle}\n\n## ADDED Requirements\n\n${deltas}\n`;
  Bun.write(join(dir, 'spec.md'), spec);
}

export function convertToVerbItem(store: DocumentStore, proposal: GroomProposal): VerbItem {
  // A card is born only on a verb the engine serves: built-in or registered
  // through `deck workflow` (hooks-runner extension point).
  if (!store.isRegisteredVerb(proposal.proposedVerb)) {
    throw new DeckError(
      `verb '${proposal.proposedVerb}' is not registered — built-ins or 'deck workflow <verb>' names only`,
      { noteId: proposal.noteId, verb: proposal.proposedVerb },
    );
  }
  if (proposal.openQuestions.length > 0) {
    throw new DeckError(
      `groom proposal for ${proposal.noteId} has ${proposal.openQuestions.length} ` +
        `unanswered open questions — answer them before accepting`,
      { noteId: proposal.noteId, openQuestions: proposal.openQuestions },
    );
  }
  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, proposal.noteId)).get();
    if (!row || row.type !== 'note') throw new NotFoundError('note', proposal.noteId);
    const position = endPosition(
      tx
        .select({ position: cards.position })
        .from(cards)
        .where(eq(cards.lane, 'groomed'))
        .all()
        .map((laneRow) => laneRow.position),
    );
    tx.update(cards)
      .set({
        type: 'verb',
        title: proposal.refinedTitle,
        verb: proposal.proposedVerb,
        lane: 'groomed',
        position,
        specPath: `specs/changes/${proposal.proposedVerb}-${row.id}/`,
        research: JSON.stringify(proposal.research),
        updatedAt: nowIso(),
      })
      .where(eq(cards.id, proposal.noteId))
      .run();
    tx.delete(tasks).where(eq(tasks.cardId, proposal.noteId)).run();
    for (const [index, title] of proposal.tasks.entries()) {
      tx.insert(tasks)
        .values({ cardId: proposal.noteId, idx: index, id: newTaskId(), title, done: false })
        .run();
    }
    emitEvent(tx, 'card.groomed', { id: proposal.noteId, lane: 'groomed', position });
  });
  const item = store.getVerbItem(proposal.noteId);
  materializeSpec(store.projectPath, item.specPath, proposal);
  recordSpecVersion(store, proposal.noteId, renderCardSpec(store, item));
  return item;
}

export function demoteToNote(store: DocumentStore, cardId: string): Note {
  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, cardId)).get();
    if (!row || row.type !== 'verb' || row.lane !== 'groomed') {
      throw new NotFoundError('groomed verb item', cardId);
    }
    const position = endPosition(
      tx
        .select({ position: cards.position })
        .from(cards)
        .where(eq(cards.lane, 'todo'))
        .all()
        .map((laneRow) => laneRow.position),
    );
    tx.update(cards)
      .set({
        type: 'note',
        title: row.title,
        verb: null,
        lane: 'todo',
        position,
        specPath: null,
        research: null,
        blockedReason: null,
        blockedAt: null,
        updatedAt: nowIso(),
      })
      .where(eq(cards.id, cardId))
      .run();
    tx.delete(tasks).where(eq(tasks.cardId, cardId)).run();
    emitEvent(tx, 'card.moved', { id: cardId, lane: 'todo', position });
  });
  return store.getNote(cardId);
}

export function tweak(store: DocumentStore, id: string): Tweak {
  assertUnderWip(store);
  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, id)).get();
    if (!row || row.type === 'verb' || row.lane !== 'todo') {
      throw new NotFoundError('todo note', id);
    }
    const position = endPosition(
      tx
        .select({ position: cards.position })
        .from(cards)
        .where(eq(cards.lane, 'active'))
        .all()
        .map((laneRow) => laneRow.position),
    );
    tx.update(cards)
      .set({ type: 'tweak', lane: 'active', position, requirement: row.title, updatedAt: nowIso() })
      .where(eq(cards.id, id))
      .run();
    tx.delete(tasks).where(eq(tasks.cardId, id)).run();
    tx.insert(tasks)
      .values({ cardId: id, idx: 0, id: newTaskId(), title: row.title, done: false })
      .run();
    emitEvent(tx, 'card.moved', { id, lane: 'active', position });
  });
  return store.getCard(id) as Tweak;
}

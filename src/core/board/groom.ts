import { eq } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DeckError, NotFoundError } from './errors.ts';
import { newTaskId } from './ids.ts';
import { endPosition } from './positions.ts';
import { cards, issueMap, publishQueue, specs, tasks } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';
import type { GroomProposal, Note, Tweak, VerbItem } from './types.ts';
import { getSpecType, sectionGate } from './types-registry.ts';
import { emitEvent } from '../events/outbox.ts';
import { assertUnderWip } from './lanes.ts';
import { recordSpecVersion, renderCardSpec, enqueuePublish } from './specstore.ts';

function nowIso(): string {
  return new Date().toISOString();
}

// Story-first spec law: spec.md carries the full design document — Story
// (what & why, mermaid fences pass through for GitHub to render), Research
// (findings + RCA), Requirements (the deltas — format pinned for the review
// gate parser), Blast radius (only when it touches existing code). The h1
// header is added at render time (renderCardSpec), not here. tasks.md stays
// the checklist — the only technical/code-level artifact.
export function materializeSpec(
  projectPath: string,
  specPath: string,
  proposal: GroomProposal,
  doneByTitle: ReadonlyMap<string, boolean> = new Map(),
  sectionLabels: ReadonlyMap<string, string> = new Map(),
): void {
  const dir = join(projectPath, specPath);
  mkdirSync(dir, { recursive: true });
  const checklist = proposal.tasks.map((task) => `- [${doneByTitle.get(task) === true ? 'x' : ' '}] ${task}`).join('\n');
  Bun.write(join(dir, 'tasks.md'), `${checklist}\n`);

  const sections: string[] = [];
  const story = proposal.research.story?.trim();
  if (story !== undefined && story !== '') {
    sections.push(`## Story\n\n${story}\n`);
  }
  const findings = proposal.research.codebaseFindings.filter((line) => line.trim() !== '');
  const rca = proposal.research.rca?.trim();
  if (findings.length > 0 || (rca !== undefined && rca !== '')) {
    const parts: string[] = [];
    if (findings.length > 0) {
      parts.push(`### Findings\n\n${findings.map((line) => `- ${line}`).join('\n')}\n`);
    }
    if (rca !== undefined && rca !== '') {
      parts.push(`### Root cause\n\n${rca}\n`);
    }
    sections.push(`## Research\n\n${parts.join('')}`);
  }
  const deltas = proposal.specDeltas
    .map((delta) => `### ${delta.op}: ${delta.requirement}\n${delta.text}\n`)
    .join('\n');
  sections.push(`## Requirements\n\n${deltas}`);
  const blast = (proposal.research.blastRadius ?? []).filter((line) => line.trim() !== '');
  if (blast.length > 0) {
    sections.push(`## Blast radius\n\n${blast.map((line) => `- ${line}`).join('\n')}\n`);
  }
  // Spec-type registry sections: one `## <label>` block per section id the
  // groom filled, in registry order, after the fixed core sections. Labels
  // are the caller's map (registry id → label) — this function stays pure.
  for (const [id, label] of sectionLabels) {
    const content = proposal.research.sections?.[id]?.trim();
    if (content === undefined || content === '') continue;
    sections.push(`## ${label}\n\n${content}\n`);
  }
  Bun.write(join(dir, 'spec.md'), sections.join('\n'));
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
  // Spec-type gate (shared with verb start): the registry's required
  // sections for this type must be present in the proposal. Existence
  // first so the typed 404 contract wins over the gate.
  store.getNote(proposal.noteId);
  const type = getSpecType(store, proposal.proposedVerb);
  const missing = sectionGate(type, proposal.research);
  if (missing.length > 0) {
    throw new DeckError(
      `groom proposal for ${proposal.noteId} as '${proposal.proposedVerb}' is missing required ` +
        `section(s): ${missing.join(', ')} — fill them and re-groom`,
      { noteId: proposal.noteId, verb: proposal.proposedVerb, missing },
    );
  }
  // Shape law (jira-style direction): >3 tasks is story-shaped — the spec
  // must say what and why, or the work belongs in an epic of smaller cards.
  const hasSpecContent =
    (proposal.research.story ?? '').trim() !== '' ||
    proposal.specDeltas.length > 0 ||
    proposal.research.codebaseFindings.length > 0;
  if (proposal.tasks.length > 3 && !hasSpecContent) {
    throw new DeckError(
      `groom proposal for ${proposal.noteId} is story-shaped (${proposal.tasks.length} tasks) ` +
        `without a spec — write the story (what & why, findings) or split it into an epic of smaller cards`,
      { noteId: proposal.noteId, tasks: proposal.tasks.length },
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
        // Spec materialization lives under .deck (db is truth, the user's
        // repo stays md-free), shaped Jira-style: >3 tasks is story-shaped,
        // anything less is a task card. Existing cards keep their recorded
        // specPath — render and re-groom follow the card, never the layout.
        specPath: `.deck/specs/${proposal.tasks.length > 3 ? 'stories' : 'tasks'}/${proposal.proposedVerb}-${row.id}/`,
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
  materializeSpec(store.projectPath, item.specPath, proposal, new Map(), sectionLabels(type));
  const version = recordSpecVersion(store, proposal.noteId, renderCardSpec(store, item));
  // Issues at groom: the spec publishes as a DRAFT issue from birth —
  // queue-first (deck sync flushes lazily), never blocking the groom.
  enqueuePublish(store, proposal.noteId, version.checksum);
  return item;
}

// Registry id → label map for materializeSpec's section rendering.
export function sectionLabels(type: { sections: Array<{ id: string; label: string }> }): Map<string, string> {
  return new Map(type.sections.map((section) => [section.id, section.label]));
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
    // Cascade the card's derived rows like deleteCard — a note back in todo
    // has no spec/issue identity, and a surviving issue_map/publish_queue/
    // specs row would make deck sync's drift loop crash on the dead verb id.
    const draftIssue = tx.select().from(issueMap).where(eq(issueMap.cardId, cardId)).get();
    tx.delete(issueMap).where(eq(issueMap.cardId, cardId)).run();
    tx.delete(publishQueue).where(eq(publishQueue.cardId, cardId)).run();
    tx.delete(specs).where(eq(specs.cardId, cardId)).run();
    emitEvent(tx, 'card.moved', { id: cardId, lane: 'todo', position });
    // A draft issue published at groom dies with the groom: best-effort
    // close (sync reports the leftover as drift if it fails).
    if (draftIssue !== undefined && draftIssue.state !== 'closed') {
      void import('../git/issues.ts').then(({ closeIssue }) =>
        closeIssue(store.projectPath, draftIssue.issueNumber).catch(() => undefined),
      );
    }
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

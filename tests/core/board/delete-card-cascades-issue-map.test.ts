import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { deleteCard } from '../../../src/core/board/crud.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { syncProject } from '../../../src/core/board/publish.ts';
import { enqueuePublish, setIssueMap } from '../../../src/core/board/specstore.ts';
import { issueMap, publishQueue, specs } from '../../../src/core/board/schema.ts';

// Requirement: delete card cascades issue map cleanup — deleteCard removes
// issue_map/publish_queue/specs rows in the same transaction, and
// syncProject reports an orphaned map row as drift instead of crashing.
let dir: string;
let store: DocumentStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-cascade-'));
  store = await openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function groomedPublishedCard(title: string): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'fix',
    refinedTitle: title,
    research: { codebaseFindings: [], sections: { reproduce: 'steps', rca: 'cause' } },
    specDeltas: [],
    tasks: ['do it'],
    openQuestions: [],
  });
  // convertToVerbItem already records spec version 1
  setIssueMap(store, { cardId: note.id, issueNumber: 77, state: 'open', checksum: 'abc' });
  enqueuePublish(store, note.id, 'abc');
  return note.id;
}

describe('deleteCard cascade', () => {
  test('removes issue_map, publish_queue, and specs rows with the card', () => {
    const id = groomedPublishedCard('cascade me');
    deleteCard(store, id);

    expect(store.db.select().from(issueMap).where(eq(issueMap.cardId, id)).all()).toHaveLength(0);
    expect(store.db.select().from(publishQueue).where(eq(publishQueue.cardId, id)).all()).toHaveLength(0);
    expect(store.db.select().from(specs).where(eq(specs.cardId, id)).all()).toHaveLength(0);
    expect(store.listCards().some((card) => card.id === id)).toBe(false);
  });

  test('other cards keep their map/queue/version rows', () => {
    const keep = groomedPublishedCard('keep my rows');
    const drop = groomedPublishedCard('drop my rows');
    deleteCard(store, drop);

    expect(store.db.select().from(issueMap).where(eq(issueMap.cardId, keep)).all()).toHaveLength(1);
    expect(store.db.select().from(publishQueue).where(eq(publishQueue.cardId, keep)).all()).toHaveLength(1);
    expect(store.db.select().from(specs).where(eq(specs.cardId, keep)).all()).toHaveLength(1);
  });
});

describe('syncProject orphan resilience', () => {
  test('an orphaned map row is drift, not a crash', async () => {
    // A row whose card is gone (pre-cascade delete or hand-edited db) —
    // getCard would throw NotFoundError and used to abort the whole report.
    setIssueMap(store, { cardId: 'ghost-card', issueNumber: 99, state: 'open', checksum: 'zzz' });
    const report = await syncProject(store);
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]!.kind).toBe('missing');
    expect(report.drift[0]!.issueNumber).toBe(99);
    expect(report.drift[0]!.detail).toContain('deleted card');
  });
});

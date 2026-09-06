import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { boardView, epicRollups, todoView, cardView } from '../../../src/core/board/views.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { applyVerifyResult } from '../../../src/core/board/verify.ts';
import { moveLane } from '../../../src/core/board/lanes.ts';
import { tmpProject } from '../../helpers.ts';

// epic-planning — the paired file for the "Epic progress rollup"
// requirement: rollup computes live from card state, views expose it, and
// card views carry the epic pointer for the UI chip.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-epic-rollup-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

describe('epic progress rollup', () => {
  test('rollup counts stories done/total across types and lanes', async () => {
    const epic = store.addEpic('rollup epic');
    const done = store.addNote('done story');
    const open = store.addNote('open story');
    store.setEpic(done.id, epic.id);
    store.setEpic(open.id, epic.id);
    // a note "done": groom → verb → verify-lane → clean
    convertToVerbItem(store, { noteId: done.id, proposedVerb: 'feat', refinedTitle: 'done story', research: { codebaseFindings: [] }, specDeltas: [], tasks: ['t'], openQuestions: [] });
    moveLane(store, done.id, 'verify', 'engine');
    applyVerifyResult(store, done.id, 'clean');
    const rollup = epicRollups(store).find((r) => r.id === epic.id);
    expect(rollup).toMatchObject({ stories: 2, done: 1 });
    // both views expose the same rollup
    expect(boardView(store).epics.find((r) => r.id === epic.id)?.done).toBe(1);
    expect(todoView(store).epics.find((r) => r.id === epic.id)?.stories).toBe(2);
  });

  test('card views carry the epic pointer for the UI chip', () => {
    const epic = store.addEpic('chip epic');
    const note = store.addNote('chip story');
    store.setEpic(note.id, epic.id);
    convertToVerbItem(store, { noteId: note.id, proposedVerb: 'feat', refinedTitle: 'chip story', research: { codebaseFindings: [] }, specDeltas: [], tasks: ['t'], openQuestions: [] });
    const view = cardView(store.getCard(note.id));
    expect(view['epicId']).toBe(epic.id);
    // an unattached card carries no pointer
    const free = store.addNote('free card');
    convertToVerbItem(store, { noteId: free.id, proposedVerb: 'feat', refinedTitle: 'free card', research: { codebaseFindings: [] }, specDeltas: [], tasks: ['t'], openQuestions: [] });
    expect(cardView(store.getCard(free.id))['epicId']).toBeUndefined();
  });
});

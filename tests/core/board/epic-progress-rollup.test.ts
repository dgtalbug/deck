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

// --- E03: dependency-aware ready selection + review-needed (DECK-ARCH-016) ---
import { setDependencies, unmetDependencies } from '../../../src/core/board/planning.ts';
import { firstReady } from '../../../src/core/board/lanes.ts';
import { planningStatus } from '../../../src/core/board/views.ts';

describe('E03 dependency-aware selection + review-needed', () => {
  test('independent story stays eligible; blocked story is skipped and explained in order', () => {
    // drain leftovers from earlier tests so queue order is fully controlled
    for (const card of store.listCards('groomed')) moveLane(store, card.id, 'done', 'engine');
    const first = convertToVerbItem(store, {
      noteId: store.addNote('blocked queued story').id,
      proposedVerb: 'feat',
      refinedTitle: 'blocked queued story',
      research: { codebaseFindings: ['e'] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    const second = convertToVerbItem(store, {
      noteId: store.addNote('independent queued story').id,
      proposedVerb: 'feat',
      refinedTitle: 'independent queued story',
      research: { codebaseFindings: ['e'] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    const prereq = convertToVerbItem(store, {
      noteId: store.addNote('unfinished prereq').id,
      proposedVerb: 'feat',
      refinedTitle: 'unfinished prereq',
      research: { codebaseFindings: ['e'] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    setDependencies(store, first.id, [prereq.id]);
    // queue order: first, second — first is blocked, second is independent
    const selection = firstReady(store);
    expect(selection.card?.id).toBe(second.id);
    expect(selection.skipped).toHaveLength(1);
    expect(selection.skipped[0]!.card.id).toBe(first.id);
    expect(selection.skipped[0]!.blockers).toEqual([{ id: prereq.id, lane: 'groomed', title: 'unfinished prereq' }]);
    // once the prerequisite reaches done, the first story becomes ready again
    moveLane(store, prereq.id, 'done', 'engine');
    expect(firstReady(store).card?.id).toBe(first.id);
    setDependencies(store, first.id, []); // cleanup: keep the queue drivable
  });

  test('upstream reopened → downstream in-flight work is review-needed, progress intact', () => {
    const upstream = convertToVerbItem(store, {
      noteId: store.addNote('reopen upstream').id,
      proposedVerb: 'feat',
      refinedTitle: 'reopen upstream',
      research: { codebaseFindings: ['e'] },
      specDeltas: [],
      tasks: ['done work', 'more work'],
      openQuestions: [],
    });
    const downstream = convertToVerbItem(store, {
      noteId: store.addNote('in-flight dependent').id,
      proposedVerb: 'feat',
      refinedTitle: 'in-flight dependent',
      research: { codebaseFindings: ['e'] },
      specDeltas: [],
      tasks: ['progress made'],
      openQuestions: [],
    });
    moveLane(store, upstream.id, 'done', 'engine');
    moveLane(store, downstream.id, 'active', 'engine');
    store.syncTasks(downstream.id, [{ id: 'w1', title: 'progress made', done: true }], 'engine');
    setDependencies(store, downstream.id, [upstream.id]);
    // while upstream is done: no blockers
    expect(unmetDependencies(store, downstream.id)).toEqual([]);
    // reopen: done → active (engine)
    moveLane(store, upstream.id, 'active', 'engine');
    const status = planningStatus(store, store.getCard(downstream.id));
    expect(status?.reviewNeeded).toBe(true);
    expect(status?.blockers.map((blocker) => blocker.id)).toEqual([upstream.id]);
    // the dependent kept its completed task history
    expect(store.getVerbItem(downstream.id).tasks[0]!.done).toBe(true);
    // and the dependent is NOT read as blocked once upstream finishes again
    moveLane(store, upstream.id, 'done', 'engine');
    expect(planningStatus(store, store.getCard(downstream.id))).toBeUndefined();
  });
});

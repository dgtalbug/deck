import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { moveLane } from '../../../src/core/board/lanes.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { cards, cleanupTasks, deliveries, operations } from '../../../src/core/board/schema.ts';
import {
  LIVE_RECORD_LIMIT,
  LIVE_TASK_LIMIT,
  liveCounts,
  retentionSelection,
  runRetention,
} from '../../../src/core/board/history.ts';
import { boardView } from '../../../src/core/board/views.ts';
import { nextDigest } from '../../../src/core/board/next.ts';
import { setDependencies, unmetDependencies } from '../../../src/core/board/planning.ts';
import { tmpProject } from '../../helpers.ts';

// Live retention: threshold boundaries, eligibility, exclusions, idempotency,
// inclusive detail/dependency reads and reopen un-hiding. Cards are driven
// through the engine lane path so completion stamps and retention integrate.
let store: DocumentStore;
let path: string;
let cleanup: () => void;

beforeEach(async () => {
  const project = tmpProject('deck-history-');
  path = project.path;
  cleanup = project.cleanup;
  store = await openStore(path);
});

afterEach(() => {
  cleanup();
});

function doneStory(index: number, tasks = 1, title = `history story ${index}`): string {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: ['has spec content'], sections: { what: 'w', why: 'y' } },
    specDeltas: [],
    tasks: Array.from({ length: tasks }, (_, t) => `task ${t}`),
    openQuestions: [],
  });
  moveLane(store, item.id, 'done', 'engine');
  return item.id;
}

function historyOf(id: string): string | null {
  return store.db.select({ historyAt: cards.historyAt }).from(cards).where(eq(cards.id, id)).get()?.historyAt ?? null;
}

describe('live retention thresholds', () => {
  test('exactly 100 records and 500 tasks does not trigger rotation', () => {
    for (let i = 0; i < LIVE_RECORD_LIMIT; i++) doneStory(i, 5);
    const counts = liveCounts(store);
    expect(counts).toEqual({ records: LIVE_RECORD_LIMIT, tasks: LIVE_TASK_LIMIT });
    const selection = retentionSelection(store);
    expect(selection.archiveStories).toEqual([]);
    expect(selection.overflow).toBe(null);
    // last moveLane already ran retention; nothing rotated
    expect(store.db.select().from(cards).all().every((row) => row.historyAt === null)).toBe(true);
  });

  test('101 records rotates exactly one oldest story', () => {
    const ids: string[] = [];
    for (let i = 0; i < LIVE_RECORD_LIMIT + 1; i++) ids.push(doneStory(i));
    const counts = liveCounts(store);
    expect(counts.records).toBe(LIVE_RECORD_LIMIT); // the +1 already rotated
    expect(historyOf(ids[0]!)).not.toBe(null); // oldest by completion time
    expect(ids.slice(1).every((id) => historyOf(id) === null)).toBe(true);
  });

  test('501 tasks with fewer records rotates the oldest stories until under the task limit', () => {
    // 11 stories x 50 tasks = 550 task rows; records stay far below 100
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push(doneStory(i, 50));
    const counts = liveCounts(store);
    expect(counts.tasks).toBe(LIVE_TASK_LIMIT); // exactly one story (50 tasks) rotated
    expect(historyOf(ids[0]!)).not.toBe(null);
    expect(ids.slice(1).every((id) => historyOf(id) === null)).toBe(true);
  });

  test('notes never count toward thresholds', () => {
    for (let i = 0; i < 150; i++) store.addNote(`note ${i}`);
    const counts = liveCounts(store);
    expect(counts.records).toBe(0);
    expect(retentionSelection(store).archiveStories).toEqual([]);
  });

  test('unfinished-only overflow retains everything and reports the overflow', () => {
    // 101 stories, none done: no eligible candidate exists
    for (let i = 0; i < LIVE_RECORD_LIMIT + 1; i++) {
      const note = store.addNote(`unfinished ${i}`);
      convertToVerbItem(store, {
        noteId: note.id,
        proposedVerb: 'feat',
        refinedTitle: `unfinished ${i}`,
        research: { codebaseFindings: ['has spec content'], sections: { what: 'w', why: 'y' } },
        specDeltas: [],
        tasks: ['one'],
        openQuestions: [],
      });
    }
    const result = runRetention(store);
    expect(result.archived).toEqual([]);
    expect(result.overflow).not.toBe(null);
    expect(store.db.select().from(cards).all().every((row) => row.historyAt === null)).toBe(true);
    // the ordinary board read still shows all unfinished work
    const view = boardView(store);
    expect(view.lanes['todo']!.length + view.lanes['groomed']!.length).toBe(LIVE_RECORD_LIMIT + 1);
  });

  test('tasks move only with their story, never independently', () => {
    const id = doneStory(0, 3);
    runRetention(store);
    const taskRows = store.db.select().from(cards).where(eq(cards.id, id)).all();
    expect(taskRows).toHaveLength(1);
  });
});

describe('eligibility exclusions', () => {
  test('a done story with an in-flight operation stays live', () => {
    const id = doneStory(0);
    // seed an unsettled operation directly (engine boundary owns this table)
    const now = new Date().toISOString();
    store.db.insert(operations)
      .values({ id: 'op-test', cardId: id, kind: 'start', owner: 'agent', checkout: path, state: 'active', createdAt: now, updatedAt: now })
      .run();
    // force over-threshold and run retention manually
    for (let i = 1; i <= LIVE_RECORD_LIMIT; i++) doneStory(i);
    const counts = liveCounts(store);
    expect(counts.records).toBe(LIVE_RECORD_LIMIT);
    expect(historyOf(id)).toBe(null); // excluded from rotation
    store.db.update(operations).set({ state: 'completed' }).where(eq(operations.id, 'op-test')).run();
    doneStory(-1); // push back over the record threshold
    runRetention(store);
    expect(historyOf(id)).not.toBe(null); // oldest eligible candidate now rotates
  });

  test('a done story with pending delivery cleanup stays live', () => {
    // seed the pending cleanup before completion so retention sees it
    const note = store.addNote('cleanup story');
    const item = convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'cleanup story',
      research: { codebaseFindings: ['has spec content'], sections: { what: 'w', why: 'y' } },
      specDeltas: [],
      tasks: Array.from({ length: LIVE_TASK_LIMIT + 1 }, (_, t) => `task ${t}`),
      openQuestions: [],
    });
    const now = new Date().toISOString();
    store.db.insert(deliveries)
      .values({ id: 'dlv-1', cardId: item.id, attempt: 1, mode: 'solo', policyVersion: 1, scopeRevision: 1, state: 'delivered', createdAt: now, updatedAt: now })
      .run();
    store.db.insert(cleanupTasks)
      .values({ id: 'cl-1', cardId: item.id, deliveryId: 'dlv-1', kind: 'issue-close', state: 'pending', attempts: 0, createdAt: now, updatedAt: now })
      .run();
    moveLane(store, item.id, 'done', 'engine'); // completion runs retention inline
    expect(historyOf(item.id)).toBe(null); // pending cleanup blocks rotation
    store.db.update(cleanupTasks).set({ state: 'done' }).where(eq(cleanupTasks.id, 'cl-1')).run();
    expect(runRetention(store).archived).toEqual([item.id]); // eligible after reconciliation
  });

  test('a live parent keeps historical children in its rollup', () => {
    const epic = store.addEpic('parent epic');
    const first = doneStory(0, 1, 'child one');
    const note = store.addNote('child two');
    const second = convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'child two',
      research: { codebaseFindings: ['has spec content'], sections: { what: 'w', why: 'y' } },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    store.setEpic(first, epic.id);
    store.setEpic(second.id, epic.id);
    // rotate `first` manually
    store.db.update(cards).set({ historyAt: new Date().toISOString() }).where(eq(cards.id, first)).run();
    const view = boardView(store);
    const rollup = view.epics.find((entry) => entry['id'] === epic.id);
    expect(rollup).toMatchObject({ stories: 2, done: 1 }); // historical child still counted
  });
});

describe('history preserves authoritative facts and access', () => {
  test('historical done prerequisites remain satisfied and detail stays reachable', () => {
    const prereq = doneStory(0);
    const note = store.addNote('dependent story');
    const dependent = convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'dependent story',
      research: { codebaseFindings: ['has spec content'], sections: { what: 'w', why: 'y' } },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    setDependencies(store, dependent.id, [prereq]);
    store.db.update(cards).set({ historyAt: new Date().toISOString() }).where(eq(cards.id, prereq)).run();
    // inclusive dependency read: the historical done prereq is still met
    expect(unmetDependencies(store, dependent.id)).toEqual([]);
    // detail by id remains reachable
    expect(store.getCard(dependent.id).id).toBe(dependent.id);
    expect(store.getCard(prereq).id).toBe(prereq);
  });

  test('an authorized reopen unhides the story and its parent', () => {
    const epic = store.addEpic('reopen parent');
    const id = doneStory(0, 1, 'reopen story');
    store.setEpic(id, epic.id);
    const at = new Date().toISOString();
    store.db.update(cards).set({ historyAt: at }).where(eq(cards.id, id)).run();
    store.db.update(cards).set({ historyAt: at }).where(eq(cards.id, epic.id)).run();
    // engine reopen: done → active (authorized boundary)
    moveLane(store, id, 'active', 'engine');
    expect(historyOf(id)).toBe(null);
    expect(historyOf(epic.id)).toBe(null);
  });

  test('repeated retention passes are idempotent', () => {
    for (let i = 0; i < LIVE_RECORD_LIMIT + 2; i++) doneStory(i);
    const afterFirst = liveCounts(store);
    const second = runRetention(store);
    expect(second.archived).toEqual([]);
    expect(liveCounts(store)).toEqual(afterFirst);
  });

  test('retention does not disturb next selection on an under-limit board', () => {
    doneStory(0);
    const digest = nextDigest(store);
    expect(digest.context.length).toBeGreaterThan(0);
  });
});

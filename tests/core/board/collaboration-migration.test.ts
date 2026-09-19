import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openStore } from '../../../src/core/board/store.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { getTaskAssignment } from '../../../src/core/board/task-patches.ts';
import { updateGroom } from '../../../src/core/board/crud.ts';
import type { DocumentStore } from '../../../src/core/board/store.ts';
import { tmpProject } from '../../helpers.ts';

let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-collab-mig-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

function groomThreeTasks(title: string): string {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: ['x'] },
    specDeltas: [{ op: 'ADDED', requirement: 'req', text: 'text' }],
    tasks: ['one', 'two', 'three'],
    openQuestions: [],
  });
  return item.id;
}

describe('collaboration migration', () => {
  test('existing tasks get task_state rows with revision 1 and no owner', () => {
    const cardId = groomThreeTasks('migration baseline');
    const item = store.getVerbItem(cardId);
    for (const task of item.tasks) {
      const assignment = getTaskAssignment(store, cardId, task.id);
      expect(assignment.revision).toBe(1);
      expect(assignment.owner).toBeNull();
    }
  });

  test('task ids survive engine whole-list replacement', () => {
    const cardId = groomThreeTasks('replacement keeps ids');
    const item = store.getVerbItem(cardId);
    const first = item.tasks[0]!;
    const next = item.tasks.map((task) => ({ ...task, done: task.id === first.id }));
    store.syncTasks(cardId, next, 'engine');
    const assignment = getTaskAssignment(store, cardId, first.id);
    expect(assignment.owner).toBeNull();
    expect(store.getVerbItem(cardId).tasks.find((task) => task.id === first.id)?.done).toBe(true);
  });

  test('removed tasks drop their task_state rows', () => {
    const cardId = groomThreeTasks('removal drops state');
    const item = store.getVerbItem(cardId);
    const removed = item.tasks[2]!;
    // removal is a scope operation; the accepted plan edit drops the task and
    // its progress row together
    updateGroom(store, cardId, {
      noteId: cardId,
      proposedVerb: 'feat',
      refinedTitle: 'removal drops state',
      research: { codebaseFindings: ['x'] },
      specDeltas: [{ op: 'ADDED', requirement: 'req', text: 'text' }],
      tasks: ['one', 'two'],
      openQuestions: [],
      taskOps: [
        { op: 'keep', id: item.tasks[0]!.id },
        { op: 'keep', id: item.tasks[1]!.id },
        { op: 'remove', id: removed.id },
      ],
    });
    const row = store.raw().query('SELECT * FROM task_state WHERE task_id = ?').get(removed.id);
    expect(row).toBeNull();
    expect(store.getVerbItem(cardId).tasks.map((task) => task.title)).toEqual(['one', 'two']);
  });
});

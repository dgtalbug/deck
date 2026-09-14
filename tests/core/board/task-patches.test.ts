import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openStore } from '../../../src/core/board/store.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import {
  applyTaskPatch,
  assignTask,
  DuplicateCommandConflictError,
  getTaskAssignment,
  TaskNotAssignedError,
  TaskOwnerMismatchError,
} from '../../../src/core/board/task-patches.ts';
import { NotFoundError, StaleWriterError } from '../../../src/core/board/errors.ts';
import type { DocumentStore } from '../../../src/core/board/store.ts';
import { tmpProject } from '../../helpers.ts';

let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-task-patches-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

function groomTasks(title: string, taskTitles: string[]): { cardId: string; taskIds: string[] } {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: ['x'] },
    specDeltas: [{ op: 'ADDED', requirement: 'req', text: 'text' }],
    tasks: taskTitles,
    openQuestions: [],
  });
  return { cardId: item.id, taskIds: item.tasks.map((task) => task.id) };
}

describe('targeted task patches', () => {
  test('unassigned task refuses patches before assignment', () => {
    const { cardId, taskIds } = groomTasks('assignment gate', ['a', 'b']);
    expect(() =>
      applyTaskPatch(store, { cardId, taskId: taskIds[0]!, expectedRevision: 1, owner: 'agent-a', commandId: 'c0', done: true }),
    ).toThrow(TaskNotAssignedError);
  });

  test('two owners patch independent tasks without conflict', () => {
    const { cardId, taskIds } = groomTasks('independent edits', ['a', 'b']);
    const a = assignTask(store, { cardId, taskId: taskIds[0]!, owner: 'agent-a', by: 'human' });
    const b = assignTask(store, { cardId, taskId: taskIds[1]!, owner: 'agent-b', by: 'human' });
    const first = applyTaskPatch(store, { cardId, taskId: taskIds[0]!, expectedRevision: a.revision, owner: 'agent-a', commandId: 'c1', done: true });
    const second = applyTaskPatch(store, { cardId, taskId: taskIds[1]!, expectedRevision: b.revision, owner: 'agent-b', commandId: 'c2', done: true });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
    expect(store.getVerbItem(cardId).tasks.every((task) => task.done)).toBe(true);
  });

  test('stale revision refuses with current state', () => {
    const { cardId, taskIds } = groomTasks('stale write', ['a']);
    const a = assignTask(store, { cardId, taskId: taskIds[0]!, owner: 'agent-a', by: 'human' });
    applyTaskPatch(store, { cardId, taskId: taskIds[0]!, expectedRevision: a.revision, owner: 'agent-a', commandId: 'c3', done: true });
    expect(() =>
      applyTaskPatch(store, { cardId, taskId: taskIds[0]!, expectedRevision: a.revision, owner: 'agent-a', commandId: 'c4', done: false }),
    ).toThrow(StaleWriterError);
    expect(store.getVerbItem(cardId).tasks[0]!.done).toBe(true);
  });

  test('foreign owner refuses', () => {
    const { cardId, taskIds } = groomTasks('foreign owner', ['a']);
    assignTask(store, { cardId, taskId: taskIds[0]!, owner: 'agent-a', by: 'human' });
    expect(() =>
      applyTaskPatch(store, { cardId, taskId: taskIds[0]!, expectedRevision: 2, owner: 'agent-b', commandId: 'c5', done: true }),
    ).toThrow(TaskOwnerMismatchError);
  });

  test('duplicate command id replays original result; mismatched payload conflicts', () => {
    const { cardId, taskIds } = groomTasks('idempotency', ['a']);
    const a = assignTask(store, { cardId, taskId: taskIds[0]!, owner: 'agent-a', by: 'human' });
    const result = applyTaskPatch(store, { cardId, taskId: taskIds[0]!, expectedRevision: a.revision, owner: 'agent-a', commandId: 'cmd-x', done: true });
    const replay = applyTaskPatch(store, { cardId, taskId: taskIds[0]!, expectedRevision: a.revision, owner: 'agent-a', commandId: 'cmd-x', done: true });
    expect(replay.duplicate).toBe(true);
    expect(replay.revision).toBe(result.revision);
    expect(getTaskAssignment(store, cardId, taskIds[0]!).revision).toBe(result.revision);
    expect(() =>
      applyTaskPatch(store, { cardId, taskId: taskIds[0]!, expectedRevision: a.revision, owner: 'agent-a', commandId: 'cmd-x', done: false }),
    ).toThrow(DuplicateCommandConflictError);
  });

  test('patch to removed task refuses', () => {
    const { cardId, taskIds } = groomTasks('removed task', ['a', 'b']);
    assignTask(store, { cardId, taskId: taskIds[0]!, owner: 'agent-a', by: 'human' });
    const item = store.getVerbItem(cardId);
    store.syncTasks(cardId, item.tasks.filter((task) => task.id !== taskIds[0]!), 'engine');
    expect(() =>
      applyTaskPatch(store, { cardId, taskId: taskIds[0]!, expectedRevision: 2, owner: 'agent-a', commandId: 'c6', done: true }),
    ).toThrow(NotFoundError);
  });

  test('checkbox patch does not change scope revision or lane', () => {
    const { cardId, taskIds } = groomTasks('scope separation', ['a', 'b']);
    const a = assignTask(store, { cardId, taskId: taskIds[0]!, owner: 'agent-a', by: 'human' });
    const before = store.getVerbItem(cardId);
    applyTaskPatch(store, { cardId, taskId: taskIds[0]!, expectedRevision: a.revision, owner: 'agent-a', commandId: 'c7', done: true });
    const after = store.getVerbItem(cardId);
    expect(after.lane).toBe(before.lane);
    expect((after as { scopeRevision?: number }).scopeRevision).toBe((before as { scopeRevision?: number }).scopeRevision);
  });

  test('whole-list replacement refuses non-internal sources', () => {
    const { cardId } = groomTasks('replacement gate', ['a']);
    const item = store.getVerbItem(cardId);
    expect(() => store.syncTasks(cardId, item.tasks, 'public' as never)).toThrow(/internal-only/);
  });
});

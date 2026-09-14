import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { applyTaskPatch, assignTask, getTaskAssignment } from '../../src/core/board/task-patches.ts';
import {
  acceptHandoff,
  cancelHandoff,
  HandoffStateError,
  listHandoffs,
  offerHandoff,
} from '../../src/core/engine/handoffs.ts';
import { writeCheckpoint } from '../../src/core/board/checkpoint.ts';
import { reserveOperation, completeOperation } from '../../src/core/engine/ownership.ts';
import { DeckError } from '../../src/core/board/errors.ts';
import { TaskOwnerMismatchError } from '../../src/core/board/task-patches.ts';
import type { DocumentStore } from '../../src/core/board/store.ts';
import { tmpProject } from '../helpers.ts';

let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-handoffs-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

function groomAssigned(title: string, owner: string): { cardId: string; taskIds: string[]; revision: number } {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: ['x'] },
    specDeltas: [{ op: 'ADDED', requirement: 'req', text: 'text' }],
    tasks: ['one'],
    openQuestions: [],
  });
  const assignment = assignTask(store, { cardId: item.id, taskId: item.tasks[0]!.id, owner, by: 'human' });
  return { cardId: item.id, taskIds: item.tasks.map((task) => task.id), revision: assignment.revision };
}

describe('handoffs', () => {
  test('unaccepted offer leaves sender responsible; recipient cannot patch under the offer', () => {
    const { cardId, taskIds, revision } = groomAssigned('unaccepted offer', 'agent-a');
    const offer = offerHandoff(store, {
      cardId,
      taskId: taskIds[0]!,
      sender: 'agent-a',
      recipient: 'agent-b',
      remainingWork: 'finish the loop',
    });
    expect(offer.state).toBe('offered');
    expect(getTaskAssignment(store, cardId, taskIds[0]!).owner).toBe('agent-a');
    expect(() =>
      applyTaskPatch(store, { cardId, taskId: taskIds[0]!, expectedRevision: revision, owner: 'agent-b', commandId: 'h0', done: true }),
    ).toThrow(TaskOwnerMismatchError);
  });

  test('acceptance transfers ownership and fences the stale owner', () => {
    const { cardId, taskIds, revision } = groomAssigned('accepted transfer', 'agent-a');
    const offer = offerHandoff(store, { cardId, taskId: taskIds[0]!, sender: 'agent-a', recipient: 'agent-b' });
    const accepted = acceptHandoff(store, { handoffId: offer.id, recipient: 'agent-b' });
    expect(accepted.state).toBe('accepted');
    const assignment = getTaskAssignment(store, cardId, taskIds[0]!);
    expect(assignment.owner).toBe('agent-b');
    expect(() =>
      applyTaskPatch(store, { cardId, taskId: taskIds[0]!, expectedRevision: assignment.revision, owner: 'agent-a', commandId: 'h1', done: true }),
    ).toThrow(TaskOwnerMismatchError);
  });

  test('acceptance retry after interruption is idempotent', () => {
    const { cardId, taskIds } = groomAssigned('retry acceptance', 'agent-a');
    const offer = offerHandoff(store, { cardId, taskId: taskIds[0]!, sender: 'agent-a', recipient: 'agent-b' });
    const first = acceptHandoff(store, { handoffId: offer.id, recipient: 'agent-b' });
    const retry = acceptHandoff(store, { handoffId: offer.id, recipient: 'agent-b' });
    expect(retry.state).toBe('accepted');
    expect(retry.closedAt).toBe(first.closedAt);
    expect(listHandoffs(store, { cardId }).filter((h) => h.state === 'accepted')).toHaveLength(1);
  });

  test('stale scope basis refuses acceptance', () => {
    const { cardId, taskIds } = groomAssigned('stale scope', 'agent-a');
    const offer = offerHandoff(store, { cardId, taskId: taskIds[0]!, sender: 'agent-a', recipient: 'agent-b' });
    store.raw()
      .query('UPDATE cards SET scope_revision = scope_revision + 1 WHERE id = ?')
      .run(cardId);
    expect(() => acceptHandoff(store, { handoffId: offer.id, recipient: 'agent-b' })).toThrow(HandoffStateError);
  });

  test('stale checkpoint basis refuses acceptance', () => {
    const { cardId, taskIds } = groomAssigned('stale checkpoint', 'agent-a');
    writeCheckpoint(project.path, cardId, { kind: 'decision', text: 'first basis', basis: 'scope:1:abc' });
    const offer = offerHandoff(store, { cardId, taskId: taskIds[0]!, sender: 'agent-a', recipient: 'agent-b' });
    writeCheckpoint(project.path, cardId, { kind: 'decision', text: 'second basis', basis: 'scope:1:abc' });
    expect(() => acceptHandoff(store, { handoffId: offer.id, recipient: 'agent-b' })).toThrow(/checkpoint changed/);
  });

  test('unsettled engine operation blocks acceptance', () => {
    const { cardId, taskIds } = groomAssigned('unsettled op', 'agent-a');
    const op = reserveOperation(store, cardId, 'start');
    const offer = offerHandoff(store, { cardId, taskId: taskIds[0]!, sender: 'agent-a', recipient: 'agent-b' });
    expect(() => acceptHandoff(store, { handoffId: offer.id, recipient: 'agent-b' })).toThrow(/unsettled engine operation/);
    completeOperation(store, op.id);
    const accepted = acceptHandoff(store, { handoffId: offer.id, recipient: 'agent-b' });
    expect(accepted.state).toBe('accepted');
  });

  test('only the intended recipient can accept', () => {
    const { cardId, taskIds } = groomAssigned('wrong recipient', 'agent-a');
    const offer = offerHandoff(store, { cardId, taskId: taskIds[0]!, sender: 'agent-a', recipient: 'agent-b' });
    expect(() => acceptHandoff(store, { handoffId: offer.id, recipient: 'agent-c' })).toThrow(DeckError);
  });

  test('sender can cancel a pending offer; cancelled offers cannot be accepted', () => {
    const { cardId, taskIds } = groomAssigned('cancellation', 'agent-a');
    const offer = offerHandoff(store, { cardId, taskId: taskIds[0]!, sender: 'agent-a', recipient: 'agent-b' });
    const cancelled = cancelHandoff(store, { handoffId: offer.id, owner: 'agent-a' });
    expect(cancelled.state).toBe('cancelled');
    expect(getTaskAssignment(store, cardId, taskIds[0]!).owner).toBe('agent-a');
    expect(() => acceptHandoff(store, { handoffId: offer.id, recipient: 'agent-b' })).toThrow(HandoffStateError);
    expect(() => cancelHandoff(store, { handoffId: offer.id, owner: 'agent-b' })).toThrow(TaskOwnerMismatchError);
  });

  test('duplicate offer is idempotent for the same sender/recipient pair', () => {
    const { cardId, taskIds } = groomAssigned('idempotent offer', 'agent-a');
    const first = offerHandoff(store, { cardId, taskId: taskIds[0]!, sender: 'agent-a', recipient: 'agent-b', remainingWork: 'x' });
    const second = offerHandoff(store, { cardId, taskId: taskIds[0]!, sender: 'agent-a', recipient: 'agent-b', remainingWork: 'x' });
    expect(second.id).toBe(first.id);
  });
});

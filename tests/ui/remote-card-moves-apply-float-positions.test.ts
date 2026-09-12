import { describe, expect, test } from 'bun:test';
import { createBoardStore } from '../../src/ui/slices/board/store.ts';
import type { BoardApi, BoardDoc, UiCard } from '../../src/ui/slices/board/api.ts';

// Requirement: remote card moves apply float positions — the SSE
// card.moved handler inserts by comparing the event's float position
// against neighbor positions (positions.ts 1024-step scheme), never as a
// 1-based ordinal, and stamps the position on the card so later moves
// compare correctly.
//
// Same-process note: this file shares the bun test process — the store is
// factory-created per test, no global state is touched.

function floatDoc(): BoardDoc {
  const card = (id: string, position: number): UiCard => ({ id, title: id, position });
  return {
    lanes: {
      todo: [card('a', 1024), card('b', 2048), card('c', 3072)],
      groomed: [card('g', 1024)],
      active: [],
      verify: [],
      done: [],
    },
  };
}

function apiWith(doc: BoardDoc): BoardApi {
  return {
    listProjects: () => Promise.resolve({ projects: [] }),
    fetchBoard: () => Promise.resolve(doc),
    fetchTodo: () => Promise.resolve({ view: 'todo', cards: [] }),
    fetchNext: () => Promise.resolve({ cardId: 'x', title: 'x', context: 'x' }),
    fetchGit: () => Promise.resolve({ repo: false, recent: [] }),
    updateCard: () => Promise.resolve({} as UiCard),
    deleteCard: () => Promise.resolve(),
    updateGroom: () => Promise.resolve({} as UiCard),
    addNote: () => Promise.resolve({} as UiCard),
    groom: () => Promise.resolve({} as UiCard),
    move: () => Promise.resolve({} as UiCard),
    reorder: () => Promise.resolve({} as UiCard),
    block: () => Promise.resolve({} as UiCard),
    unblock: () => Promise.resolve({} as UiCard),
    tweak: () => Promise.resolve({} as UiCard),
    demote: () => Promise.resolve({} as UiCard),
    createBranch: () => Promise.resolve({ output: '' }),
    switchBranch: () => Promise.resolve({ output: '' }),
    mergeBranch: () => Promise.resolve({ output: '' }),
    commitAll: () => Promise.resolve({ output: '' }),
    undoLastCommit: () => Promise.resolve({ output: '' }),
    stashPush: () => Promise.resolve({ output: '' }),
    stashPop: () => Promise.resolve({ output: '' }),
    deleteBranch: () => Promise.resolve({ output: '' }),
    fetchRemote: () => Promise.resolve({ output: '' }),
    pullRemote: () => Promise.resolve({ output: '' }),
    pushRemote: () => Promise.resolve({ output: '' }),
    fetchPulls: () => Promise.resolve([]),
    createPullRequest: () => Promise.resolve({ url: 'u' }),
  };
}

describe('remote card moves apply float positions', () => {
  test('a midpoint move lands between its neighbors, not at the lane end', async () => {
    const store = createBoardStore('p', apiWith(floatDoc()));
    await store.refetch();

    // old ordinal bug: position 1536 → clamp(min(len, 1535)) → lane end
    store.applyEvents([{ rowid: 1, type: 'card.moved', payload: { id: 'c', lane: 'todo', position: 1536 } }]);
    expect(store.board.value.lanes.todo.map((card) => card.id)).toEqual(['a', 'c', 'b']);
  });

  test('the moved card carries its new position so the next remote move compares right', async () => {
    const store = createBoardStore('p', apiWith(floatDoc()));
    await store.refetch();

    store.applyEvents([{ rowid: 1, type: 'card.moved', payload: { id: 'b', lane: 'todo', position: 512 } }]);
    expect(store.board.value.lanes.todo.map((card) => card.id)).toEqual(['b', 'a', 'c']);
    // replay of the same event (reconnect resend) is a no-op
    store.applyEvents([{ rowid: 2, type: 'card.moved', payload: { id: 'b', lane: 'todo', position: 512 } }]);
    expect(store.board.value.lanes.todo.map((card) => card.id)).toEqual(['b', 'a', 'c']);
  });

  test('cross-lane move inserts by float position inside the target lane', async () => {
    const store = createBoardStore('p', apiWith(floatDoc()));
    await store.refetch();

    store.applyEvents([{ rowid: 1, type: 'card.moved', payload: { id: 'c', lane: 'groomed', position: 1536 } }]);
    expect(store.board.value.lanes.groomed.map((card) => card.id)).toEqual(['g', 'c']);
    expect(store.board.value.lanes.todo.map((card) => card.id)).toEqual(['a', 'b']);
  });
});

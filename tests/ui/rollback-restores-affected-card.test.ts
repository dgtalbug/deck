import { describe, expect, test } from 'bun:test';
import { createBoardStore } from '../../src/ui/slices/board/store.ts';
import { ApiError, type BoardApi, type BoardDoc } from '../../src/ui/slices/board/api.ts';

// The paired file for the "Rollback Restores Affected Card" requirement: a
// failed mutation rolls back ONLY the affected card — SSE deltas that landed
// on other cards during the in-flight window survive the rollback.

function doc(cards: { id: string; lane: 'todo' | 'groomed' }[]): BoardDoc {
  const board: BoardDoc = { lanes: { todo: [], groomed: [], active: [], verify: [], done: [] } };
  for (const card of cards) {
    board.lanes[card.lane].push({ id: card.id, title: card.id, position: (board.lanes[card.lane].length + 1) * 1024 });
  }
  return board;
}

describe('per-card rollback', () => {
  test('a failed delete keeps the SSE delta that landed mid-flight on another card', async () => {
    const initial = doc([
      { id: 'a', lane: 'todo' },
      { id: 'b', lane: 'todo' },
    ]);
    let midFlight: (() => void) | undefined;
    const api: BoardApi = {
      listProjects: () => Promise.resolve({ projects: [] }),
      fetchBoard: () => Promise.resolve(initial),
      fetchTodo: () => Promise.resolve({ view: 'todo', cards: [] }),
      fetchNext: () => Promise.resolve({ cardId: 'x', title: 'x', context: 'x' }),
      addNote: () => Promise.resolve({ id: 'n', title: 'n' }),
      deleteCard: (_project: string, _id: string) =>
        new Promise((_resolve, reject) => {
          // An SSE delta lands while the request is outstanding…
          midFlight?.();
          setTimeout(() => reject(new ApiError(400, 'refused')), 10);
        }),
    } as unknown as BoardApi;
    const store = createBoardStore('p', api);
    await store.refetch();

    midFlight = () => {
      store.applyEvents([
        { rowid: 99, type: 'card.created', payload: { id: 'remote-note', lane: 'todo' } },
      ] as never);
    };

    const ok = await store.deleteCard('a');
    expect(ok).toBe(false);

    // The failed card is back in todo, AND the remote note survived — the
    // rollback never clobbered the concurrent change with the whole snapshot.
    const ids = (store.board.value.lanes.todo ?? []).map((card) => card.id);
    expect(ids).toContain('a');
    expect(ids).toContain('remote-note');
  });
});

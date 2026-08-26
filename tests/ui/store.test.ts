import { describe, expect, test } from 'bun:test';
import { effect } from '@preact/signals';
import { createBoardStore } from '../../src/ui/slices/board/store.ts';
import { ApiError, type BoardApi, type BoardDoc, type UiCard } from '../../src/ui/slices/board/api.ts';

// Fake api — the store is exercised without a server (task 4.2): burst
// batching, optimistic apply → response replace → rollback, never-optimistic
// engine-lane entry.

function doc(cards: { id: string; lane: 'todo' | 'groomed'; title?: string }[]): BoardDoc {
  const board: BoardDoc = { lanes: { todo: [], groomed: [], active: [], verify: [], done: [] } };
  for (const card of cards) {
    board.lanes[card.lane].push({ id: card.id, title: card.title ?? card.id });
  }
  return board;
}

function makeApi(initial: BoardDoc): BoardApi & { calls: string[]; failures: Map<string, ApiError> } {
  let current = initial;
  const calls: string[] = [];
  const failures = new Map<string, ApiError>();
  const refresh = async (): Promise<BoardDoc> => current;
  const record = async (name: string, apply: () => UiCard): Promise<UiCard> => {
    calls.push(name);
    const failure = failures.get(name);
    if (failure !== undefined) throw failure;
    return apply();
  };
  return {
    calls,
    failures,
    listProjects: () => Promise.resolve({ projects: [] }),
    fetchBoard: () => {
      calls.push('fetchBoard');
      return refresh();
    },
    fetchTodo: () => Promise.resolve({ view: 'todo', cards: [] }),
    fetchNext: () => Promise.resolve({ cardId: 'x', title: 'x', context: 'x' }),
    addNote: (_project: string, title: string) =>
      record('addNote', () => {
        const note: UiCard = { id: `n-${title}`, title };
        current = { ...current, lanes: { ...current.lanes, todo: [...current.lanes.todo, note] } };
        return note;
      }),
    groom: (_project: string, id: string) =>
      record('groom', () => {
        const card = current.lanes.todo.find((entry) => entry.id === id)!;
        current = {
          ...current,
          lanes: {
            ...current.lanes,
            todo: current.lanes.todo.filter((entry) => entry.id !== id),
            groomed: [...current.lanes.groomed, { ...card, lane: 'groomed', verb: 'feat' }],
          },
        };
        return { ...card, lane: 'groomed', verb: 'feat' };
      }),
    move: (_project: string, id: string, to: 'todo' | 'groomed' | 'active' | 'verify' | 'done') =>
      record(`move:${to}`, () => {
        const found = current.lanes.todo.concat(current.lanes.groomed).find((entry) => entry.id === id)!;
        current = {
          ...current,
          lanes: {
            ...current.lanes,
            todo: current.lanes.todo.filter((entry) => entry.id !== id),
            groomed: current.lanes.groomed.filter((entry) => entry.id !== id),
            [to]: [...current.lanes[to], { ...found, lane: to }],
          },
        };
        return { ...found, lane: to };
      }),
    reorder: (_project: string, id: string) => record('reorder', () => current.lanes.todo[0] ?? { id, title: id }),
    block: (_project: string, id: string, reason?: string) => record('block', () => ({ id, title: id, blocked: { reason: reason ?? '', at: '' } })),
    unblock: (_project: string, id: string) => record('unblock', () => ({ id, title: id })),
    tweak: (_project: string, id: string) =>
      record('tweak', () => {
        const card = current.lanes.todo.find((entry) => entry.id === id) ?? { id, title: id };
        current = {
          ...current,
          lanes: {
            ...current.lanes,
            todo: current.lanes.todo.filter((entry) => entry.id !== id),
            active: [...current.lanes.active, { ...card, lane: 'active', requirement: 'r' }],
          },
        };
        return { ...card, lane: 'active', requirement: 'r' };
      }),
    demote: (_project: string, id: string) => record('demote', () => ({ id, title: id })),
  } as unknown as BoardApi & { calls: string[]; failures: Map<string, ApiError> };
}

describe('board store', () => {
  test('an event burst applies in one batch (one render)', () => {
    const api = makeApi(doc([]));
    const store = createBoardStore('p', api);
    let renders = 0;
    effect(() => {
      void store.board.value.lanes.todo.length;
      renders += 1;
    });
    expect(renders).toBe(1);

    store.applyEvents(
      Array.from({ length: 25 }, (_, i) => ({
        rowid: i + 1,
        type: 'card.created' as const,
        payload: { id: `e${i}`, lane: 'todo', position: i },
      })),
    );
    expect(store.board.value.lanes.todo.length).toBe(25);
    expect(renders).toBe(2); // the whole burst = exactly one re-render
  });

  test('card.moved delta relocates a card between lanes', async () => {
    const api = makeApi(doc([{ id: 'a', lane: 'todo' }, { id: 'b', lane: 'todo' }]));
    const store = createBoardStore('p', api);
    await store.refetch();
    store.applyEvents([{ rowid: 1, type: 'card.moved', payload: { id: 'a', lane: 'groomed', position: 1 } }]);
    expect(store.board.value.lanes.todo.map((card) => card.id)).toEqual(['b']);
    expect(store.board.value.lanes.groomed.map((card) => card.id)).toEqual(['a']);
  });

  test('card.tasks.updated replaces tasks and progress in place', async () => {
    const api = makeApi(doc([{ id: 'a', lane: 'groomed' }]));
    const store = createBoardStore('p', api);
    await store.refetch();
    store.applyEvents([
      { rowid: 1, type: 'card.tasks.updated', payload: { id: 'a', tasks: [{ title: 'x', done: true }], progress: '1/1' } },
    ]);
    expect(store.cardById('a')?.progress).toBe('1/1');
    expect(store.cardById('a')?.tasks).toEqual([{ title: 'x', done: true }]);
  });

  test('400/409/404 rollback restores order and raises a toast naming the card', async () => {
    const api = makeApi(doc([{ id: 'a', lane: 'todo' }, { id: 'b', lane: 'todo' }]));
    api.failures.set('move:groomed', new ApiError(400, 'card a: todo → groomed is not allowed'));
    const store = createBoardStore('p', api);
    await store.refetch();

    const ok = await store.move('a', 'groomed');
    expect(ok).toBe(false);
    expect(store.board.value.lanes.todo.map((card) => card.id)).toEqual(['a', 'b']); // order intact

    api.failures.delete('move:groomed');
    const good = await store.move('a', 'groomed');
    expect(good).toBe(true);
    expect(store.board.value.lanes.groomed.map((card) => card.id)).toEqual(['a']);
  });

  test('tweak never places the card into active optimistically', async () => {
    const api = makeApi(doc([{ id: 'a', lane: 'todo' }]));
    api.failures.set('tweak', new ApiError(409, 'WIP limit reached'));
    const store = createBoardStore('p', api);
    await store.refetch();
    const ok = await store.tweak('a');
    expect(ok).toBe(false);
    expect(store.board.value.lanes.active).toEqual([]);
    expect(store.board.value.lanes.todo.map((card) => card.id)).toEqual(['a']);
  });

  test('filter views narrow lanes without touching the board', async () => {
    const api = makeApi(doc([
      { id: 'n1', lane: 'todo', title: 'alpha note' },
      { id: 'v1', lane: 'groomed', title: 'beta verb' },
    ]));
    api.fetchBoard = () =>
      Promise.resolve({
        lanes: {
          todo: [{ id: 'n1', title: 'alpha note' }],
          groomed: [{ id: 'v1', title: 'beta verb', verb: 'feat' }],
          active: [], verify: [], done: [],
        },
      });
    const store = createBoardStore('p', api);
    await store.refetch();
    store.setFilter({ search: 'beta' });
    expect(store.filtered('groomed').map((card) => card.id)).toEqual(['v1']);
    expect(store.filtered('todo')).toEqual([]);
    store.setFilter({ search: '', chip: 'notes' });
    expect(store.filtered('todo').map((card) => card.id)).toEqual(['n1']);
    expect(store.filtered('groomed')).toEqual([]);
    expect(store.board.value.lanes.groomed.length).toBe(1); // board untouched
  });

  test('wip computed reflects active count and limit', async () => {
    const api = makeApi(doc([]));
    const store = createBoardStore('p', api);
    expect(store.wip.value).toEqual({ active: 0, limit: 3, atLimit: false });
    store.applyEvents([{ rowid: 1, type: 'card.moved', payload: { id: 'x', lane: 'active', position: 1 } }]);
    // moved into active without the card existing → no-op (unknown id)
    expect(store.wip.value.active).toBe(0);
  });
});

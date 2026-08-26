import { describe, expect, test } from 'bun:test';
import { effect } from '@preact/signals';
import { createBoardStore } from '../../src/ui/slices/board/store.ts';
import { ApiError, type BoardApi, type BoardDoc, type GroomInput, type UiCard } from '../../src/ui/slices/board/api.ts';

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
  const record = async (name: string, apply: () => UiCard | void): Promise<UiCard | void> => {
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
    updateCard: (_project: string, id: string, title: string) =>
      record(`update:${id}`, () => {
        let updated: UiCard = { id, title };
        current = {
          ...current,
          lanes: Object.fromEntries(
            Object.entries(current.lanes).map(([lane, cards]) => [
              lane,
              cards.map((entry) => {
                if (entry.id !== id) return entry;
                updated = { ...entry, title };
                return updated;
              }),
            ]),
          ) as BoardDoc['lanes'],
        };
        return updated;
      }),
    deleteCard: (_project: string, id: string) =>
      record(`delete:${id}`, () => {
        current = {
          ...current,
          lanes: Object.fromEntries(
            Object.entries(current.lanes).map(([lane, cards]) => [lane, cards.filter((entry) => entry.id !== id)]),
          ) as BoardDoc['lanes'],
        };
      }),
    updateGroom: (_project: string, id: string, input: GroomInput) =>
      record(`updateGroom:${id}`, () => {
        let updated: UiCard = { id, title: input.refinedTitle };
        current = {
          ...current,
          lanes: Object.fromEntries(
            Object.entries(current.lanes).map(([lane, cards]) => [
              lane,
              cards.map((entry) => {
                if (entry.id !== id) return entry;
                updated = { ...entry, title: input.refinedTitle, ...(input.proposedVerb !== undefined ? { verb: input.proposedVerb } : {}) };
                return updated;
              }),
            ]),
          ) as BoardDoc['lanes'],
        };
        return updated;
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

describe('SSE idempotency + echo suppression (findings 6+7)', () => {
  test('a replayed event (same rowid) never re-applies', async () => {
    const api = makeApi(doc([{ id: 'a', lane: 'todo' }, { id: 'b', lane: 'todo' }]));
    const store = createBoardStore('p', api);
    await store.refetch();
    const event = { rowid: 7, type: 'card.moved' as const, payload: { id: 'a', lane: 'groomed', position: 1 } };
    store.applyEvents([event]);
    const afterFirst = store.board.value;
    store.applyEvents([event]); // reconnect replay
    store.applyEvents([event]); // and again
    expect(store.board.value).toBe(afterFirst);
    expect(store.board.value.lanes.groomed.map((card) => card.id)).toEqual(['a']);
  });

  test('card.moved to the same lane+position is a no-op; same-lane position moves in place', async () => {
    const api = makeApi(doc([{ id: 'a', lane: 'todo' }, { id: 'b', lane: 'todo' }, { id: 'c', lane: 'todo' }]));
    const store = createBoardStore('p', api);
    await store.refetch();
    // echo of a move that already happened (a is at position 1 of todo)
    store.applyEvents([{ rowid: 1, type: 'card.moved', payload: { id: 'a', lane: 'todo', position: 1 } }]);
    expect(store.board.value.lanes.todo.map((card) => card.id)).toEqual(['a', 'b', 'c']); // no re-append
    // a remote reorder within the lane honors position
    store.applyEvents([{ rowid: 2, type: 'card.moved', payload: { id: 'a', lane: 'todo', position: 3 } }]);
    expect(store.board.value.lanes.todo.map((card) => card.id)).toEqual(['b', 'c', 'a']);
    // cross-lane insertion honors position too (not a blind append)
    store.applyEvents([{ rowid: 3, type: 'card.moved', payload: { id: 'x', lane: 'todo', position: 1 } }]);
    store.applyEvents([{ rowid: 4, type: 'card.moved', payload: { id: 'b', lane: 'groomed', position: 1 } }]);
    store.applyEvents([{ rowid: 5, type: 'card.created', payload: { id: 'n', lane: 'todo', position: 4 } }]);
    store.applyEvents([{ rowid: 6, type: 'card.moved', payload: { id: 'n', lane: 'groomed', position: 1 } }]);
    expect(store.board.value.lanes.groomed.map((card) => card.id)).toEqual(['n', 'b']);
  });

  test('card.created for an existing id never duplicates the stub', async () => {
    const api = makeApi(doc([{ id: 'a', lane: 'todo' }]));
    const store = createBoardStore('p', api);
    await store.refetch();
    store.applyEvents([{ rowid: 1, type: 'card.created', payload: { id: 'a', lane: 'todo', position: 1 } }]);
    expect(store.board.value.lanes.todo.length).toBe(1);
  });

  test('an echoed delta for an in-flight mutation is dropped until the response lands', async () => {
    const base = doc([{ id: 'a', lane: 'todo' }, { id: 'b', lane: 'todo' }]);
    let current = base;
    let release: (() => void) | null = null;
    const api = makeApi(base);
    api.move = (_project: string, id: string, to: 'todo' | 'groomed' | 'active' | 'verify' | 'done') =>
      new Promise((resolve) => {
        release = () => {
          const found = current.lanes.todo.find((entry) => entry.id === id)!;
          current = {
            ...current,
            lanes: {
              ...current.lanes,
              todo: current.lanes.todo.filter((entry) => entry.id !== id),
              groomed: [...current.lanes.groomed, { ...found, lane: to }],
            },
          };
          resolve({ ...found, lane: to });
        };
      });
    api.fetchBoard = () => Promise.resolve(current);
    const store = createBoardStore('p', api);
    await store.refetch();

    let settled!: (value: boolean) => void;
    const done = new Promise<boolean>((resolve) => {
      settled = resolve;
    });
    void store.move('a', 'groomed').then((ok) => settled(ok));

    // the SSE echo arrives while the mutation is in flight → suppressed
    store.applyEvents([{ rowid: 1, type: 'card.moved', payload: { id: 'a', lane: 'groomed', position: 1 } }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.board.value.lanes.groomed.length).toBe(1); // optimistic state only

    release!();
    expect(await done).toBe(true);
    expect(store.board.value.lanes.groomed.map((card) => card.id)).toEqual(['a']);

    // window closed: a later remote delta for the same card applies again
    store.applyEvents([{ rowid: 2, type: 'card.moved', payload: { id: 'a', lane: 'todo', position: 2 } }]);
    expect(store.board.value.lanes.todo.map((card) => card.id)).toEqual(['b', 'a']);
  });

  test('remote moves cue exactly the moved card and the cue clears', async () => {
    const api = makeApi(doc([{ id: 'a', lane: 'todo' }]));
    const store = createBoardStore('p', api);
    await store.refetch();
    store.applyEvents([{ rowid: 1, type: 'card.moved', payload: { id: 'a', lane: 'groomed', position: 1 } }]);
    expect([...store.remoteMoved.value]).toEqual(['a']);
    await new Promise((resolve) => setTimeout(resolve, 500)); // cue lifetime
    expect([...store.remoteMoved.value]).toEqual([]);
  });
});

describe('card CRUD mutations + new SSE events (v0.2.0)', () => {
  const groomInput = { proposedVerb: 'fix' as const, refinedTitle: 'revised', research: { codebaseFindings: [] }, specDeltas: [], tasks: [], openQuestions: [] };

  test('rename applies optimistically and rolls back on failure', async () => {
    const api = makeApi(doc([{ id: 'a', lane: 'todo' }]));
    api.failures.set('update:a', new ApiError(400, 'nope'));
    const store = createBoardStore('p', api);
    await store.refetch();
    const ok = await store.updateCard('a', 'new title');
    expect(ok).toBe(false);
    expect(store.cardById('a')?.title).toBe('a'); // rolled back
    api.failures.delete('update:a');
    const good = await store.updateCard('a', 'new title');
    expect(good).toBe(true);
    expect(store.cardById('a')?.title).toBe('new title');
  });

  test('delete removes optimistically and restores on failure', async () => {
    const api = makeApi(doc([{ id: 'a', lane: 'todo' }, { id: 'b', lane: 'todo' }]));
    api.failures.set('delete:a', new ApiError(400, 'refused'));
    const store = createBoardStore('p', api);
    await store.refetch();
    expect(await store.deleteCard('a')).toBe(false);
    expect(store.board.value.lanes.todo.map((card) => card.id)).toEqual(['a', 'b']);
    api.failures.delete('delete:a');
    expect(await store.deleteCard('a')).toBe(true);
    expect(store.board.value.lanes.todo.map((card) => card.id)).toEqual(['b']);
  });

  test('updateGroom optimistically swaps verb + title', async () => {
    const api = makeApi(doc([{ id: 'v', lane: 'groomed', title: 'old' }]));
    const store = createBoardStore('p', api);
    await store.refetch();
    expect(await store.updateGroom('v', groomInput)).toBe(true);
    expect(store.cardById('v')?.title).toBe('revised');
    expect(store.cardById('v')?.verb).toBe('fix');
  });

  test('SSE card.deleted removes locally without a refetch; replay is a no-op', async () => {
    const api = makeApi(doc([{ id: 'a', lane: 'todo' }, { id: 'b', lane: 'todo' }]));
    const store = createBoardStore('p', api);
    await store.refetch();
    const before = api.calls.filter((call) => call === 'fetchBoard').length;
    store.applyEvents([{ rowid: 5, type: 'card.deleted', payload: { id: 'a', lane: 'todo' } }]);
    expect(store.board.value.lanes.todo.map((card) => card.id)).toEqual(['b']);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(api.calls.filter((call) => call === 'fetchBoard').length).toBe(before); // no trailing refetch
    const state = store.board.value;
    store.applyEvents([{ rowid: 5, type: 'card.deleted', payload: { id: 'a', lane: 'todo' } }]);
    expect(store.board.value).toBe(state); // watermark replay — nothing
  });

  test('SSE card.updated schedules a trailing refetch for detail', async () => {
    const api = makeApi(doc([{ id: 'a', lane: 'todo', title: 'before' }]));
    const store = createBoardStore('p', api);
    await store.refetch();
    const before = api.calls.filter((call) => call === 'fetchBoard').length;
    store.applyEvents([{ rowid: 3, type: 'card.updated', payload: { id: 'a', lane: 'todo' } }]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(api.calls.filter((call) => call === 'fetchBoard').length).toBeGreaterThan(before);
  });
});

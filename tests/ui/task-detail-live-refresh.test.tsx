import { describe, expect, test } from 'bun:test';
import { createBoardStore } from '../../src/ui/slices/board/store.ts';
import { CardDetail, type DetailActions } from '../../src/ui/slices/board/CardDetail.tsx';
import { render } from 'preact';
import type { BoardApi, BoardDoc, BoardEvent, UiCard } from '../../src/ui/slices/board/api.ts';
import { installDom } from './dom.ts';

// Regression tests for fix-task-detail-live-refresh: cooperative task events
// (task.patched / task.assigned) must keep lane cards and an already-open
// detail in sync without reload, duplicate cards, or double-applied events.

function docWithCard(card: UiCard, lane: keyof BoardDoc['lanes']): BoardDoc {
  return { lanes: { todo: [], groomed: [], active: [], verify: [], done: [], [lane]: [card] } } as BoardDoc;
}

const CARD: UiCard = {
  id: 'feat-live-refresh',
  title: 'live refresh',
  lane: 'groomed',
  tasks: [
    { id: 't1', title: 'store: apply events', done: false },
    { id: 't2', title: 'ui: detail sync', done: false },
  ],
  progress: '0/2',
};

function makeApi(initial: BoardDoc): BoardApi & { fetches: number; current: BoardDoc } {
  const api = {
    fetches: 0,
    current: initial,
    fetchBoard: () => {
      api.fetches += 1;
      return Promise.resolve(api.current);
    },
  };
  return api as unknown as BoardApi & { fetches: number; current: BoardDoc };
}

function patched(rowid: number, taskId: string, done: boolean): BoardEvent {
  return { rowid, type: 'task.patched', payload: { id: CARD.id, taskId, done, revision: 2 } };
}

const settle = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 140));

describe('task-detail-live-refresh: store event application', () => {
  test('task.patched updates a known task and progress locally, without a refetch', async () => {
    const api = makeApi(docWithCard({ ...CARD }, 'groomed'));
    const store = createBoardStore('p', api);
    await store.refetch();

    store.applyEvents([patched(2, 't1', true)]);
    await settle();

    const card = store.cardById(CARD.id)!;
    expect(card.tasks!.find((task) => task.id === 't1')!.done).toBe(true);
    expect(card.progress).toBe('1/2');
    expect(api.fetches).toBe(1); // initial refetch only — no trailing refetch
  });

  test('task.patched for an unknown task schedules exactly one trailing refetch and duplicates nothing', async () => {
    const api = makeApi(docWithCard({ ...CARD }, 'groomed'));
    const serverDoc = docWithCard({ ...CARD, tasks: [{ id: 't1', title: 'store: apply events', done: true }, CARD.tasks![1]!], progress: '1/2' }, 'groomed');
    api.current = serverDoc;
    const store = createBoardStore('p', api);
    await store.refetch();
    api.fetches = 0;

    // burst of two unpatchable events coalesces into one refetch
    store.applyEvents([patched(2, 't-unknown', true), patched(3, 't-unknown', false)]);
    await settle();

    expect(api.fetches).toBe(1);
    const card = store.cardById(CARD.id)!;
    expect(card.tasks!.find((task) => task.id === 't1')!.done).toBe(true);
    expect(card.progress).toBe('1/2');
    expect(store.board.value.lanes.groomed.length).toBe(1);
  });

  test('task.patched for a card absent from live lanes falls back to refetch', async () => {
    const api = makeApi(docWithCard({ ...CARD }, 'groomed'));
    const store = createBoardStore('p', api);
    await store.refetch();
    api.fetches = 0;
    api.current = { lanes: { todo: [], groomed: [], active: [], verify: [], done: [] } };

    store.applyEvents([{ rowid: 2, type: 'task.patched', payload: { id: 'other-card', taskId: 't1', done: true } }]);
    await settle();

    expect(api.fetches).toBe(1);
    expect(store.cardById(CARD.id)).toBeUndefined();
    expect(store.board.value.lanes.groomed.length).toBe(0);
  });

  test('task.assigned is a freshness signal: one trailing refetch, card list stable', async () => {
    const api = makeApi(docWithCard({ ...CARD }, 'groomed'));
    const store = createBoardStore('p', api);
    await store.refetch();
    api.fetches = 0;

    store.applyEvents([{ rowid: 2, type: 'task.assigned', payload: { id: CARD.id, taskId: 't1', owner: 'agent' } }]);
    await settle();

    expect(api.fetches).toBe(1);
    expect(store.board.value.lanes.groomed.length).toBe(1);
  });

  test('duplicate rowid replay is a no-op (idempotent events)', async () => {
    const api = makeApi(docWithCard({ ...CARD }, 'groomed'));
    const store = createBoardStore('p', api);
    await store.refetch();
    api.fetches = 0;

    const event = patched(2, 't1', true);
    store.applyEvents([event]);
    store.applyEvents([event]); // replayed on reconnect: skipped by watermark
    await settle();

    const card = store.cardById(CARD.id)!;
    expect(card.tasks!.find((task) => task.id === 't1')!.done).toBe(true);
    expect(card.progress).toBe('1/2');
    expect(api.fetches).toBe(0);
  });

  test('reconnect reconciliation: refetch after missed events matches server truth', async () => {
    const api = makeApi(docWithCard({ ...CARD }, 'groomed'));
    const store = createBoardStore('p', api);
    await store.refetch();

    // events were missed while disconnected; onOpen triggers refetch
    api.current = docWithCard(
      { ...CARD, tasks: [{ id: 't1', title: 'store: apply events', done: true }, { id: 't2', title: 'ui: detail sync', done: true }], progress: '2/2' },
      'active',
    );
    await store.refetch();

    // an event observed pre-disconnect replays without corrupting state
    store.applyEvents([patched(2, 't1', true)]);
    const card = store.cardById(CARD.id)!;
    expect(store.board.value.lanes.active.length).toBe(1);
    expect(card.progress).toBe('2/2');
    expect(card.tasks!.every((task) => task.done)).toBe(true);
  });
});

describe('task-detail-live-refresh: open detail updates in place', () => {
  const actions: DetailActions = {
    onClose: () => {},
    onMoveToTodo: () => {},
    onBlock: () => {},
    onUnblock: () => {},
    onTweak: () => {},
    onDemote: () => {},
    onNext: () => {},
    onEditTitle: () => {},
    onEditGroom: () => {},
    onDelete: () => {},
  };

  test('detail checklist and meter re-render from refreshed card state without closing', async () => {
    const win = installDom();
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);

    render(<CardDetail card={{ ...CARD }} actions={actions} specMarkdown="# spec" />, container);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const dialog = win.document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('0/2');

    // the store refreshed the card (task.patched applied) → same dialog, new state
    const updated: UiCard = {
      ...CARD,
      tasks: [{ id: 't1', title: 'store: apply events', done: true }, CARD.tasks![1]!],
      progress: '1/2',
    };
    render(<CardDetail card={updated} actions={actions} specMarkdown="# spec" />, container);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const dialogAfter = win.document.querySelector('[role="dialog"]')!;
    expect(dialogAfter).toBe(dialog); // dialog stayed open (not remounted)
    expect(dialogAfter.textContent).toContain('1/2');
    expect(dialogAfter.querySelectorAll('.task').length).toBe(2);
  });
});

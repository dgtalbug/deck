import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { Board } from '../../src/ui/slices/board/Board.tsx';
import { navigate, startRouter } from '../../src/ui/router.ts';
import type { BoardApi, BoardDoc } from '../../src/ui/slices/board/api.ts';
import { disposeDnd, keyboardAfterId } from '../../src/ui/slices/board/dnd.ts';

import { installDom } from './dom.ts';

// Drag tests drive pdd with synthetic DragEvents carrying a dataTransfer
// (pdd's own testing recipe — spike S1). ONE window for the whole file:
// pdd binds its document-level listeners on the first registration, so a
// fresh document per test would orphan them. Each test renders into a
// fresh container on the shared document instead.

function dataTransfer(): unknown {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return [...store.keys()];
    },
    dropEffect: 'move',
    effectAllowed: 'move',
    setDragImage: () => {},
  };
}

let win: ReturnType<typeof installDom>;
function fire(el: Element, type: string): void {
  const event = new win.DragEvent(type, { bubbles: true, cancelable: true }) as unknown as DragEvent & { dataTransfer?: unknown };
  (event as { dataTransfer: unknown }).dataTransfer = dataTransfer();
  el.dispatchEvent(event);
}

const DOC: BoardDoc = {
  lanes: {
    todo: [
      { id: 'n1', title: 'first note' },
      { id: 'n2', title: 'second note' },
      { id: 'k1', title: 'tweak me', requirement: 'one line' },
    ],
    groomed: [{ id: 'v1', title: 'queued verb', lane: 'groomed', verb: 'feat' }],
    active: [],
    verify: [],
    done: [],
  },
};

function makeApi(doc: BoardDoc): { api: BoardApi; intents: string[] } {
  const intents: string[] = [];
  const api: BoardApi = {
    listProjects: () => Promise.resolve({ projects: [] }),
    fetchBoard: () => Promise.resolve(doc),
    fetchTodo: () => Promise.resolve({ view: 'todo', cards: [] }),
    fetchNext: () => Promise.resolve({ cardId: 'v1', title: 'top', verb: 'feat', context: 'ctx' }),
    addNote: () => Promise.resolve({ id: 'new', title: 'new' }),
    groom: () => Promise.resolve(doc.lanes.groomed[0]!),
    move: (_project, id, to) => {
      intents.push(`move:${id}->${to}`);
      return Promise.resolve({ id, title: id, lane: to });
    },
    reorder: (_project, id, afterId) => {
      intents.push(`reorder:${id} after ${afterId ?? 'top'}`);
      return Promise.resolve({ id, title: id });
    },
    block: () => Promise.resolve({ id: 'b', title: 'b' }),
    unblock: () => Promise.resolve({ id: 'u', title: 'u' }),
    tweak: () => Promise.resolve({ id: 't', title: 't', lane: 'active', requirement: 'r' }),
    demote: () => Promise.resolve({ id: 'd', title: 'd' }),
    fetchGit: () => Promise.resolve({ repo: false, recent: [] }),
    updateCard: (_p: string, id: string, title: string) => Promise.resolve({ id, title }),
    deleteCard: () => Promise.resolve(),
    updateGroom: (_p: string, id: string) => Promise.resolve({ id, title: 'g' }),
  };
  return { api, intents };
}

const silentSubscribe = (() => ({ stop() {} })) as unknown as typeof import('../../src/ui/slices/board/sse.ts').subscribeBoardEvents;

const mounted: HTMLElement[] = [];
let mountCount = 0;
async function mount(doc: BoardDoc = DOC): Promise<{ host: HTMLElement; intents: string[] }> {
  mountCount += 1;
  const name = `proj${mountCount === 1 ? '' : mountCount}`;
  const { api, intents } = makeApi(doc);
  const host = win.document.createElement('div') as unknown as HTMLElement;
  host.setAttribute('data-mount', String(mountCount));
  win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  navigate(`/${name}/`);
  mounted.push(host);
  render(<Board project={name} api={api} subscribe={silentSubscribe} />, host);
  await new Promise((resolve) => setTimeout(resolve, 80));
  return { host, intents };
}

beforeAll(() => {
  win = installDom();
  startRouter();
});

afterAll(() => {
  // unmount every Board first: orphaned Boards re-render when LATER files
  // navigate (shared route signal) and would re-mount pdd onto THEIR
  // document. Then zero pdd's usage ledger so the next file's fresh window
  // gets its own document-level bindings (see disposeDnd in dnd.ts).
  for (const host of mounted) render(null, host);
  disposeDnd();
});

describe('restricted drag (task 7.1/7.2)', () => {
  test('drop on groomed lane body emits one move intent', async () => {
    const { host, intents } = await mount();
    const card = host.querySelector('[data-id="n1"]')!;
    const groomedBody = host.querySelector('.lane[data-lane="groomed"] .lane-body')!;
    fire(card, 'dragstart');
    fire(groomedBody, 'dragover');
    expect(groomedBody.classList.contains('is-drop-target')).toBe(true);
    fire(groomedBody, 'drop');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(intents).toEqual(['move:n1->groomed']);
  });

  test('drop on an engine lane is refused — no intent, no request', async () => {
    const { host, intents } = await mount();
    const card = host.querySelector('[data-id="n1"]')!;
    const activeBody = host.querySelector('.lane[data-lane="active"] .lane-body')!;
    fire(card, 'dragstart');
    fire(activeBody, 'dragover');
    fire(activeBody, 'drop');
    fire(card, 'dragend');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(intents).toEqual([]); // structural refusal: nothing was emitted
  });

  test('same-lane drop on a card reorders after it', async () => {
    const { host, intents } = await mount();
    const card = host.querySelector('[data-id="k1"]')!;
    const target = host.querySelector('[data-id="n1"]')!;
    fire(card, 'dragstart');
    fire(target, 'dragover');
    fire(target, 'drop');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(intents).toEqual(['reorder:k1 after n1']);
  });

  test('the dragged lane stays pinned while a drag is open', async () => {
    const { host } = await mount();
    const card = host.querySelector('[data-id="n1"]')!;
    fire(card, 'dragstart');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const order = () =>
      [...host.querySelectorAll('.lane[data-lane="todo"] .kcard[data-id]')].map((el) => el.getAttribute('data-id'));
    expect(order()).toEqual(['n1', 'n2', 'k1']);
    // A remote SSE reorder lands while the drag is open: a second board with
    // reversed todo renders reversed, but the pinned lane keeps its order
    // (remote-move restraint, D-UI-08).
    const remote: BoardDoc = { lanes: { ...DOC.lanes, todo: [...DOC.lanes.todo].reverse() } };
    const second = await mount(remote);
    expect(
      [...second.host.querySelectorAll('.lane[data-lane="todo"] .kcard[data-id]')].map((el) => el.getAttribute('data-id')),
    ).toEqual(['k1', 'n2', 'n1']);
    expect(order()).toEqual(['n1', 'n2', 'k1']);
    fire(host.querySelector('.lane[data-lane="groomed"] .lane-body')!, 'drop');
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe('keyboard parity (task 7.3)', () => {
  test('full move via the card action menu, no pointer drag', async () => {
    const { host, intents } = await mount();
    // only verb items lane-move (notes leave todo via grooming) — v1 is a
    // groomed verb item, so its keyboard path is Move to Todo
    const card = host.querySelector('[data-id="v1"]')!;
    const menuButton = card.querySelector('.menu-btn') as unknown as HTMLElement;
    menuButton.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const item = [...host.querySelectorAll('.menu-item')].find((el) =>
      el.textContent?.includes('Move to Todo'),
    ) as unknown as HTMLElement;
    expect(item).toBeDefined();
    item.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(intents).toEqual(['move:v1->todo']);
    // notes DO carry a menu now (edit/delete) — but never a lane-move item
    // (the store would reject it)
    const noteCard = host.querySelector('[data-id="n2"]')!;
    const noteMenu = noteCard.querySelector('.menu-btn') as unknown as HTMLElement | null;
    if (noteMenu !== null) {
      noteMenu.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const moveItems = [...host.querySelectorAll('.menu-item')].filter((el) => el.textContent?.includes('Move to'));
      expect(moveItems).toEqual([]);
    }
  });

  test('Alt+ArrowUp/Down reorder through keyboardAfterId midpoints', async () => {
    const { host, intents } = await mount();
    const card = host.querySelector('[data-id="k1"]') as unknown as HTMLElement;
    card.focus();
    card.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(intents).toEqual(['reorder:k1 after n1']);
    card.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(intents).toEqual(['reorder:k1 after n1', 'reorder:k1 after top']);
  });

  test('keyboardAfterId edge cases', () => {
    const cards = [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }, { id: 'c', title: 'c' }];
    expect(keyboardAfterId(cards, 'a', 'up')).toBeUndefined();
    expect(keyboardAfterId(cards, 'b', 'up')).toBeUndefined();
    expect(keyboardAfterId(cards, 'c', 'up')).toBe('a');
    expect(keyboardAfterId(cards, 'a', 'down')).toBe('b');
    expect(keyboardAfterId(cards, 'c', 'down')).toBeUndefined();
    expect(keyboardAfterId(cards, 'ghost', 'up')).toBeUndefined();
  });
});

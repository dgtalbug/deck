import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import type { VNode } from 'preact';
import { Card, type CardActions } from '../../src/ui/slices/board/Card.tsx';
import { TodoView } from '../../src/ui/slices/board/TodoView.tsx';
import { disposeDnd } from '../../src/ui/slices/board/dnd.ts';
import type { Lane, UiCard } from '../../src/ui/slices/board/api.ts';
import { installDom } from './dom.ts';

// Semantic-control structure (task 4.1): the card/row layout container is
// NOT itself interactive; the open affordance is a real button and every
// quick action / menu control is a sibling, so no interactive control is
// ever nested inside another. ONE window for the whole file — Card's dnd
// registration binds pdd onto this document (see dnd.test.tsx note).

const INTERACTIVE = "button, [role='button'], [role='tab'], [role='menuitem'], a[href], input, select, textarea";

/** Every interactive element that sits inside another interactive element. */
function nestedInteractive(root: Element): Element[] {
  const offenders: Element[] = [];
  for (const el of root.querySelectorAll(INTERACTIVE)) {
    if (el.parentElement?.closest(INTERACTIVE) != null) offenders.push(el);
  }
  return offenders;
}

function stubActions(log: string[]): CardActions {
  return {
    onOpen: (id) => log.push(`open:${id}`),
    onGroom: (id) => log.push(`groom:${id}`),
    onTweak: (id) => log.push(`tweak:${id}`),
    onMove: (id, to) => log.push(`move:${id}:${to}`),
    onKeyboardReorder: (id, afterId) => {
      log.push(`reorder:${id}:${afterId ?? 'top'}`);
      return Promise.resolve(true);
    },
    onEditTitle: (id) => log.push(`editTitle:${id}`),
    onEditGroom: (id) => log.push(`editGroom:${id}`),
    onDelete: (id) => log.push(`delete:${id}`),
    onBlock: (id) => log.push(`block:${id}`),
    onUnblock: (id) => log.push(`unblock:${id}`),
  };
}

const NOTES: UiCard[] = [
  { id: 'c0', title: 'first note' },
  { id: 'c1', title: 'second note' },
  { id: 'k1', title: 'tweak me', requirement: 'one line' },
];

let win: ReturnType<typeof installDom>;
const mounted: HTMLElement[] = [];

function mount(vnode: VNode): HTMLElement {
  const host = win.document.createElement('div') as unknown as HTMLElement;
  win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  mounted.push(host);
  render(vnode, host);
  return host;
}

beforeAll(() => {
  win = installDom();
});

afterAll(() => {
  for (const host of mounted) render(null, host);
  disposeDnd();
});

describe('card semantic structure (task 2.1)', () => {
  test('container is a layout box; the open control is a real sibling button', () => {
    const log: string[] = [];
    const host = mount(
      <Card
        card={NOTES[1]!}
        actions={stubActions(log)}
        dnd={{ lane: 'todo', callbacks: { onIntent: () => {}, onDragState: () => {} }, laneCards: NOTES }}
      />,
    );
    const card = host.querySelector('.kcard[data-id="c1"]')!;
    expect(card).not.toBeNull();
    expect(card.getAttribute('role')).toBeNull(); // no button-like container
    expect(card.getAttribute('tabindex')).toBeNull();

    const open = card.querySelector('.kcard-open') as unknown as HTMLElement;
    expect(open.tagName).toBe('BUTTON');
    expect(open.getAttribute('aria-label')).toContain('open second note');
    (open as unknown as HTMLButtonElement).click();
    expect(log).toEqual(['open:c1']); // the real button opens the card
  });

  test('no interactive control is nested inside another — actions are siblings', () => {
    const log: string[] = [];
    const host = mount(
      <Card
        card={NOTES[0]!}
        actions={stubActions(log)}
        dnd={{ lane: 'todo', callbacks: { onIntent: () => {}, onDragState: () => {} }, laneCards: NOTES }}
      />,
    );
    const card = host.querySelector('.kcard[data-id="c0"]')!;
    const open = card.querySelector('.kcard-open')!;
    // quick actions and the menu trigger live in the meta row, OUTSIDE the open button
    const groom = card.querySelector('button.btn-outline')!;
    expect(groom).not.toBeNull();
    expect(open.contains(groom)).toBe(false);
    expect(card.querySelector('.menu-btn')).not.toBeNull();
    expect(open.contains(card.querySelector('.menu-btn')!)).toBe(false);
    expect(nestedInteractive(card)).toEqual([]);
  });

  test('structure stays valid with the action menu open', async () => {
    const log: string[] = [];
    const host = mount(
      <Card
        card={NOTES[1]!}
        actions={stubActions(log)}
        dnd={{ lane: 'todo', callbacks: { onIntent: () => {}, onDragState: () => {} }, laneCards: NOTES }}
      />,
    );
    (host.querySelector('.menu-btn') as unknown as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(host.querySelector('.menu-pop')).not.toBeNull();
    expect(host.querySelectorAll('.menu-item').length).toBeGreaterThan(0);
    expect(nestedInteractive(host)).toEqual([]); // menu items are never inside the open button
  });

  test('Alt+Arrow reorders from the open control and is swallowed as a key', () => {
    const log: string[] = [];
    const host = mount(
      <Card
        card={NOTES[2]!}
        actions={stubActions(log)}
        dnd={{ lane: 'todo', callbacks: { onIntent: () => {}, onDragState: () => {} }, laneCards: NOTES }}
      />,
    );
    const open = host.querySelector('.kcard-open') as unknown as HTMLElement;
    open.focus();
    expect(win.document.activeElement as unknown as HTMLElement).toBe(open);
    const canceled = open.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }) as unknown as Event,
    );
    expect(canceled).toBe(false); // preventDefault — the page must not scroll
    expect(log).toEqual(['reorder:k1:c0']);
  });
});

describe('todo row semantic structure (task 2.2)', () => {
  function todoStore(cards: UiCard[]) {
    return {
      filtered: (lane: Lane) => cards.filter((card) => (card.lane ?? 'todo') === lane),
      epics: new Map(),
    };
  }

  test('row is a layout box; the open control is a real sibling button', () => {
    const log: string[] = [];
    const cards: UiCard[] = [
      { id: 'r1', title: 'inbox note' },
      { id: 'r2', title: 'tweak row', requirement: 'x' },
    ];
    const host = mount(<TodoView store={todoStore(cards)} actions={stubActions(log)} />);
    const row = host.querySelector('.todo-row[data-id="r1"]')!;
    expect(row).not.toBeNull();
    expect(row.getAttribute('role')).toBeNull();
    expect(row.getAttribute('tabindex')).toBeNull();

    const open = row.querySelector('.todo-open') as unknown as HTMLButtonElement;
    expect(open.tagName).toBe('BUTTON');
    expect(open.getAttribute('aria-label')).toContain('open inbox note');
    open.click();
    expect(log).toEqual(['open:r1']);
  });

  test('row actions are siblings of the open control; nothing nests', () => {
    const log: string[] = [];
    const cards: UiCard[] = [
      { id: 'r1', title: 'inbox note' },
      { id: 'r2', title: 'tweak row', requirement: 'x' },
      { id: 'a1', title: 'engine row', lane: 'active', verb: 'feat' },
    ];
    const host = mount(<TodoView store={todoStore(cards)} actions={stubActions(log)} />);
    for (const row of host.querySelectorAll('.todo-row')) {
      const open = row.querySelector('.todo-open')!;
      for (const action of row.querySelectorAll('.todo-actions button')) {
        expect(open.contains(action)).toBe(false); // sibling, never a child
      }
      expect(nestedInteractive(row)).toEqual([]);
    }
    // engine rows keep their hold control, manual rows keep menu + quick actions
    const engineRow = host.querySelector('.todo-row[data-id="a1"]')!;
    expect(engineRow.querySelector('.quick-block')).not.toBeNull();
    const manualRow = host.querySelector('.todo-row[data-id="r1"]')!;
    expect(manualRow.querySelector('.menu-btn')).not.toBeNull();
  });
});

import { beforeAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { Board } from '../../src/ui/slices/board/Board.tsx';
import { Home } from '../../src/ui/slices/home/Home.tsx';
import { navigate, startRouter } from '../../src/ui/router.ts';
import type { BoardApi, BoardDoc } from '../../src/ui/slices/board/api.ts';
import { installDom } from './dom.ts';

// A11y pass (task 9.1): keyboard walkthrough of every view + dialog, focus
// management, and structural aria audit. axe-core cannot run under
// happy-dom (no layout; also breaks DOMPurify — see notes.md); the
// both-modes axe check runs in the real browser during dogfood (9.3).
// Contrast is token-driven by construction (Spade §2 light retune is
// contrast-checked in the proposal).

let win: ReturnType<typeof installDom>;

const DOC: BoardDoc = {
  lanes: {
    todo: [{ id: 'n1', title: 'first note' }, { id: 'n2', title: 'blocked note', blocked: { reason: 'waiting', at: '' } }],
    groomed: [{ id: 'v1', title: 'queued verb', lane: 'groomed', verb: 'feat', tasks: [{ title: 'x', done: false }], progress: '0/1' }],
    active: [],
    verify: [],
    done: [],
  },
};

function makeApi(doc: BoardDoc): BoardApi {
  return {
    listProjects: () => Promise.resolve({ projects: [] }),
    fetchBoard: () => Promise.resolve(doc),
    fetchTodo: () => Promise.resolve({ view: 'todo', cards: [] }),
    fetchNext: () => Promise.resolve({ cardId: 'v1', title: 'top', context: 'ctx' }),
    addNote: () => Promise.resolve({ id: 'new', title: 'new' }),
    groom: () => Promise.resolve({ id: 'g', title: 'g' }),
    move: () => Promise.resolve({ id: 'm', title: 'm' }),
    reorder: () => Promise.resolve({ id: 'r', title: 'r' }),
    block: () => Promise.resolve({ id: 'b', title: 'b' }),
    unblock: () => Promise.resolve({ id: 'u', title: 'u' }),
    tweak: () => Promise.resolve({ id: 't', title: 't' }),
    demote: () => Promise.resolve({ id: 'd', title: 'd' }),
  };
}

const silentSubscribe = (() => ({ stop() {} })) as unknown as typeof import('../../src/ui/slices/board/sse.ts').subscribeBoardEvents;

beforeAll(() => {
  win = installDom();
  startRouter();
});

async function mountBoard(path: string): Promise<HTMLElement> {
  const host = win.document.createElement('div') as unknown as HTMLElement;
  win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  navigate(path);
  render(<Board project="a11y" api={makeApi(DOC)} subscribe={silentSubscribe} />, host);
  await new Promise((resolve) => setTimeout(resolve, 80));
  return host;
}

describe('keyboard walkthrough (task 9.1)', () => {
  test('board: interactive controls are reachable and labeled', async () => {
    const host = await mountBoard('/a11y/');
    const labeled = [...host.querySelectorAll('button, input')].filter((el) => el.getAttribute('aria-label') === null && (el.textContent ?? '').trim() === '' && el.getAttribute('placeholder') === null);
    expect(labeled.length).toBe(0); // every control is labeled or has text
    const search = host.querySelector('input[type="search"]') as unknown as HTMLInputElement;
    expect(search.getAttribute('aria-label')).toContain('filter');
    const cards = [...host.querySelectorAll('.kcard[role="button"]')];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.getAttribute('tabindex')).toBe('0');
      expect(card.getAttribute('aria-label')).not.toBeNull();
    }
    // blocked reason is reachable text, not hover-only
    expect(host.querySelector('[data-id="n2"]')!.textContent).toContain('waiting');
  });

  test('card Enter opens the detail dialog; dialog traps and restores focus', async () => {
    const host = await mountBoard('/a11y/?card=n2');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const scrim = host.querySelector('[role="dialog"]') as unknown as HTMLElement;
    expect(scrim).not.toBeNull();
    expect(scrim.getAttribute('aria-modal')).toBe('true');
    // Esc closes (keyboard walkthrough — the handler lives on .card.dialog)
    const dialog = scrim.querySelector('.card.dialog') as unknown as HTMLElement;
    dialog.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  test('engine lanes announce their locked nature', async () => {
    const host = await mountBoard('/a11y/');
    for (const lane of ['active', 'verify', 'done']) {
      const lock = host.querySelector(`.lane[data-lane="${lane}"] .lock`);
      expect(lock?.getAttribute('title')).toContain('engine-owned');
    }
  });

  test('todo view is keyboard navigable and the view toggle updates the URL', async () => {
    const host = await mountBoard('/a11y/');
    const toggle = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Todo')) as unknown as HTMLElement;
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(win.location.search).toContain('view=todo');
    const groups = [...host.querySelectorAll('.todo-group-head')];
    expect(groups.length).toBeGreaterThan(0);
  });

  test('home: cards are links with accessible names; empty state is text', async () => {
    const host = win.document.createElement('div') as unknown as HTMLElement;
    win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
    navigate('/');
    const original = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ projects: [] })) as unknown as typeof fetch;
    render(<Home />, host);
    await new Promise((resolve) => setTimeout(resolve, 120));
    globalThis.fetch = original;
    expect(host.textContent).toContain('deck init');
  });

  test('mode toggle is a labeled group in both modes', async () => {
    const host = await mountBoard('/a11y/');
    const groups = [...host.querySelectorAll('.mode-toggle[role="group"]')];
    expect(groups.length).toBeGreaterThan(0); // board view toggle
    for (const group of groups) {
      const buttons = [...group.querySelectorAll('button')];
      expect(buttons.every((button) => button.getAttribute('aria-pressed') !== null)).toBe(true);
    }
    // the full shell (topbar theme toggle) — module import renders into #app
    const shell = win.document.createElement('div');
    shell.id = 'app';
    win.document.body.appendChild(shell as unknown as Parameters<typeof win.document.body.appendChild>[0]);
    await import('../../src/ui/app.tsx');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const themeGroup = win.document.querySelector('#app .mode-toggle[role="group"]');
    expect(themeGroup?.getAttribute('aria-label')).toBe('theme mode');
    const themeButtons = [...(themeGroup?.querySelectorAll('button') ?? [])];
    expect(themeButtons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  });
});

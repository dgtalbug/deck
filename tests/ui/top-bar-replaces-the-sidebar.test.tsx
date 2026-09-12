import { afterAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { Board } from '../../src/ui/slices/board/Board.tsx';
import { navigate, startRouter } from '../../src/ui/router.ts';
import type { BoardApi, BoardDoc, UiCard } from '../../src/ui/slices/board/api.ts';
import type { HTMLDivElement as HdomDiv } from 'happy-dom';
import { installDom, type TestWindow } from './dom.ts';

// Requirement: top bar replaces the project sidebar — no sidebar rail in the
// DOM; the board header row carries the segmented view switcher (URL-backed)
// and the deck-next button; the theme toggle exists only in the global
// topbar (single copy); the board keeps the full width.
const mountedContainers: HdomDiv[] = [];
let stopRouter: (() => void) | null = null;

afterAll(() => {
  for (const container of mountedContainers) render(null, container);
  stopRouter?.();
  stopRouter = null;
});

const note = (id: string, title: string): UiCard => ({ id, title });

function makeApi(doc: BoardDoc): BoardApi {
  return {
    listProjects: () => Promise.resolve({ projects: [] }),
    fetchBoard: () => Promise.resolve(doc),
    fetchTodo: () => Promise.resolve({ view: 'todo', cards: [] }),
    fetchNext: () => Promise.resolve({ cardId: 'v1', title: 'top', verb: 'feat', context: 'ctx' }),
    addNote: () => Promise.resolve(note('new', 'new')),
    groom: () => Promise.resolve(note('g', 'groomed')),
    move: () => Promise.resolve(note('m', 'moved')),
    reorder: () => Promise.resolve(note('r', 'reordered')),
    block: () => Promise.resolve(note('b', 'blocked')),
    unblock: () => Promise.resolve(note('u', 'unblocked')),
    tweak: () => Promise.resolve({ id: 't', title: 't', lane: 'active', requirement: 'r' }),
    demote: () => Promise.resolve(note('d', 'demoted')),
    fetchGit: () => Promise.resolve({ repo: false, recent: [] }),
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
    createPullRequest: () => Promise.resolve({ url: 'https://x/1' }),
    updateCard: (_p: string, id: string, title: string) => Promise.resolve({ id, title }),
    deleteCard: () => Promise.resolve(),
    updateGroom: (_p: string, id: string) => Promise.resolve({ id, title: 'g' }),
  };
}

const DOC: BoardDoc = {
  lanes: {
    todo: [note('n1', 'capture me')],
    groomed: [],
    active: [],
    verify: [],
    done: [],
  },
};

const silentSubscribe = (() => ({ stop() {} })) as unknown as typeof import('../../src/ui/slices/board/sse.ts').subscribeBoardEvents;

async function mountBoard(path = '/proj/'): Promise<TestWindow> {
  const win = installDom();
  stopRouter = startRouter();
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  mountedContainers.push(container);
  navigate(path);
  render(<Board project="proj" api={makeApi(DOC)} subscribe={silentSubscribe} />, container);
  await new Promise((resolve) => setTimeout(resolve, 80));
  return win;
}

describe('top bar replaces the project sidebar', () => {
  test('no sidebar rail; header row carries project, switcher, and deck next', async () => {
    const win = await mountBoard();
    expect(win.document.querySelector('.sidebar')).toBeNull();
    expect(win.document.querySelector('.board-shell')).toBeNull();
    const head = win.document.querySelector('.board-head-row');
    expect(head?.querySelector('h1')?.textContent).toBe('proj');
    const buttons = [...win.document.querySelectorAll('.view-switch-btn')].map(
      (btn) => (btn as unknown as HTMLElement).textContent?.trim(),
    );
    expect(buttons).toEqual(['board', 'todo', 'git']);
    expect(win.document.querySelector('[data-testid="deck-next"]')).not.toBeNull();
  });

  test('the switcher navigates URL-backed: git renders GitPage, todo groups', async () => {
    const win = await mountBoard();
    (win.document.querySelector('.view-switch-btn[data-view="git"]') as unknown as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(win.location.search).toContain('view=git');
    expect(win.document.querySelector('.git-page')).not.toBeNull();
    expect(win.document.querySelector('.view-switch-btn[data-view="git"]')?.getAttribute('aria-current')).toBe('page');

    (win.document.querySelector('.view-switch-btn[data-view="todo"]') as unknown as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(win.location.search).toContain('view=todo');
    expect(win.document.querySelector('.todo-view')).not.toBeNull();
  });

  test('deck next opens the next panel from the header row', async () => {
    const win = await mountBoard();
    (win.document.querySelector('[data-testid="deck-next"]') as unknown as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(win.document.body.textContent).toContain('top');
  });
});

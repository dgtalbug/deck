import { afterAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { GitPage } from '../../src/ui/slices/board/GitPage.tsx';
import type { BoardApi, GitDigest } from '../../src/ui/slices/board/api.ts';
import { installDom, type TestWindow } from './dom.ts';
import type { HTMLDivElement as HdomDiv } from 'happy-dom';

// Requirement: git page tabs own one responsibility — the tablist renders
// five intents (working tree, branches, sync, collaborate, history), only
// the active panel is in the DOM, the shared output block survives tab
// switches, and arrow keys move selection with a roving tabindex.
const mountedContainers: HdomDiv[] = [];

afterAll(() => {
  for (const container of mountedContainers) render(null, container);
});

const DIGEST: GitDigest = {
  repo: true,
  branch: 'main',
  head: 'abc1234',
  dirtyCount: 1,
  recent: [{ sha: 'abc1234', subject: 'first' }],
  origin: 'https://example.com/x/y.git',
  branches: ['main', 'feat/x'],
  stashCount: 0,
  gh: { available: true, account: 'tester' },
  graph: '* abc1234 first',
  tags: ['v1.0.0'],
};

function fakeApi(): BoardApi {
  const ok = () => Promise.resolve({ output: 'done' });
  return {
    listProjects: () => Promise.resolve({ projects: [] }),
    fetchBoard: () => Promise.resolve({ lanes: { todo: [], groomed: [], active: [], verify: [], done: [] } }),
    fetchTodo: () => Promise.resolve({ view: 'todo', cards: [] }),
    fetchNext: () => Promise.resolve({ cardId: 'v1', title: 't', context: 'c' }),
    fetchGit: () => Promise.resolve(DIGEST),
    updateCard: () => { throw new Error('unused'); },
    deleteCard: () => Promise.resolve(),
    updateGroom: () => { throw new Error('unused'); },
    addNote: () => { throw new Error('unused'); },
    groom: () => { throw new Error('unused'); },
    move: () => { throw new Error('unused'); },
    reorder: () => { throw new Error('unused'); },
    block: () => { throw new Error('unused'); },
    unblock: () => { throw new Error('unused'); },
    tweak: () => { throw new Error('unused'); },
    demote: () => { throw new Error('unused'); },
    createBranch: ok,
    switchBranch: ok,
    mergeBranch: ok,
    commitAll: ok,
    undoLastCommit: ok,
    stashPush: ok,
    stashPop: ok,
    deleteBranch: ok,
    fetchRemote: ok,
    pullRemote: ok,
    pushRemote: ok,
    fetchPulls: () => Promise.resolve([]),
    createPullRequest: () => Promise.resolve({ url: 'u' }),
  } as BoardApi;
}

async function mount(api: BoardApi): Promise<TestWindow> {
  const win = installDom();
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  mountedContainers.push(container);
  render(<GitPage project="proj" api={api} />, container);
  await new Promise((resolve) => setTimeout(resolve, 80));
  return win;
}

const tab = (win: TestWindow, id: string): HTMLButtonElement =>
  win.document.querySelector(`[data-testid="git-tab-${id}"]`) as unknown as HTMLButtonElement;

function keydown(win: TestWindow, el: Element, key: string): void {
  el.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }) as unknown as Event);
}

describe('git page tabs own one responsibility', () => {
  test('each tab swaps the single panel; header and output stay shared', async () => {
    const win = await mount(fakeApi());
    // working tree default: commit lives here, branches list does not
    expect(win.document.querySelector('button[data-action="commit"]')).not.toBeNull();
    expect(win.document.querySelector('.git-branch-row')).toBeNull();

    tab(win, 'branches').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(win.document.querySelector('.git-branch-row')).not.toBeNull();
    expect(win.document.querySelector('button[data-action="merge"]')).not.toBeNull();
    expect(win.document.querySelector('button[data-action="commit"]')).toBeNull(); // one panel only

    tab(win, 'sync').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(win.document.querySelector('button[data-action="fetch"]')).not.toBeNull();

    tab(win, 'collaborate').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(win.document.querySelector('.git-card[aria-label="pull requests"]')).not.toBeNull();

    // the status header never leaves
    expect(win.document.querySelector('[data-testid="git-status"]')?.textContent).toContain('main');
  });

  test('the shared output block survives tab switches', async () => {
    const win = await mount(fakeApi());
    (win.document.querySelector('button[data-action="commit"]') as unknown as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(win.document.querySelector('[data-testid="git-output"]')).not.toBeNull();

    tab(win, 'history').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // output is page-scoped: still rendered, still ok-kind
    const output = win.document.querySelector('[data-testid="git-output"]');
    expect(output?.getAttribute('data-kind')).toBe('ok');
    expect(output?.textContent).toContain('done');
  });

  test('arrow keys move selection and focus with a roving tabindex', async () => {
    const win = await mount(fakeApi());
    const working = tab(win, 'working');
    working.focus();
    keydown(win, working, 'ArrowRight');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tab(win, 'branches').getAttribute('aria-selected')).toBe('true');
    expect(win.document.activeElement?.getAttribute('data-testid')).toBe('git-tab-branches');

    keydown(win, tab(win, 'branches'), 'ArrowLeft');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tab(win, 'working').getAttribute('aria-selected')).toBe('true');

    // roving tabindex: only the selected tab is tab-reachable
    const selected = [...win.document.querySelectorAll('[role="tab"]')].filter(
      (el) => el.getAttribute('tabIndex') === '0',
    );
    expect(selected).toHaveLength(1);
  });

  test('the tabpanel is labelled by its tab', async () => {
    const win = await mount(fakeApi());
    const panel = win.document.querySelector('[role="tabpanel"]');
    expect(panel?.getAttribute('aria-labelledby')).toBe('git-tab-working');
    expect(panel?.getAttribute('id')).toBe('git-panel-working');
  });
});

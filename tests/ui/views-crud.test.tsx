import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { Board } from '../../src/ui/slices/board/Board.tsx';
import { disposeDnd } from '../../src/ui/slices/board/dnd.ts';
import { navigate, startRouter } from '../../src/ui/router.ts';
import type { BoardApi, BoardDoc, GitDigest, GroomInput, UiCard } from '../../src/ui/slices/board/api.ts';
import { installDom } from './dom.ts';

// v0.2.0 CRUD affordances end-to-end at the view level: rename, delete with
// confirm, groom re-edit prefilled, engine quick-block, and the sidebar git
// section (repo + hidden states).
//
// File sorts AFTER dnd.test.tsx on purpose: mounting Boards in a fresh
// happy-dom window before dnd runs breaks pdd's window-bound drop handling
// (see dnd.test.tsx's shared-window note) — keep this filename > 'dnd'.

const verb = (id: string, title: string, lane: NonNullable<UiCard['lane']>): UiCard => ({
  id,
  title,
  lane,
  verb: 'feat',
  tasks: [{ title: 'task one', done: true }, { title: 'task two', done: false }],
  progress: '1/2',
  research: { codebaseFindings: ['found it'] },
  specPath: `specs/changes/feat-${id}/`,
});

const DOC: BoardDoc = {
  lanes: {
    todo: [{ id: 'n1', title: 'typo note' }, { id: 'k1', title: 'tweak note', requirement: 'one line' }],
    groomed: [verb('v1', 'engine core', 'groomed')],
    active: [verb('a1', 'building', 'active')],
    verify: [],
    done: [],
  },
};

const GIT: GitDigest = {
  repo: true,
  branch: 'main',
  head: 'abc1234',
  dirtyCount: 2,
  recent: [{ sha: 'abc1234', subject: 'first commit' }],
};

function makeApi(doc: BoardDoc): { api: BoardApi; calls: string[] } {
  const calls: string[] = [];
  const api: BoardApi = {
    listProjects: () => Promise.resolve({ projects: [{ name: 'p', path: '/tmp/p', createdAt: '', activeCount: 0, doneCount: 0, lastActivity: '' }] }),
    fetchBoard: () => Promise.resolve(doc),
    fetchTodo: () => Promise.resolve({ view: 'todo', cards: [] }),
    fetchNext: () => Promise.resolve({ cardId: 'v1', title: 'top', context: 'ctx' }),
    fetchGit: () => {
      calls.push('fetchGit');
      return Promise.resolve(GIT);
    },
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
    addNote: (_p, title) => Promise.resolve({ id: `n-${title}`, title }),
    updateCard: (_p, id, title) => {
      calls.push(`updateCard:${id}:${title}`);
      doc = {
        ...doc,
        lanes: Object.fromEntries(
          Object.entries(doc.lanes).map(([lane, cards]) => [
            lane,
            cards.map((entry) => (entry.id === id ? { ...entry, title } : entry)),
          ]),
        ) as BoardDoc['lanes'],
      };
      return Promise.resolve({ id, title });
    },
    deleteCard: (_p, id) => {
      calls.push(`deleteCard:${id}`);
      doc = {
        ...doc,
        lanes: Object.fromEntries(
          Object.entries(doc.lanes).map(([lane, cards]) => [lane, cards.filter((entry) => entry.id !== id)]),
        ) as BoardDoc['lanes'],
      };
      return Promise.resolve();
    },
    updateGroom: (_p, id, input: GroomInput) => {
      calls.push(`updateGroom:${id}:${input.refinedTitle}`);
      doc = {
        ...doc,
        lanes: Object.fromEntries(
          Object.entries(doc.lanes).map(([lane, cards]) => [
            lane,
            cards.map((entry) =>
              entry.id === id ? { ...entry, title: input.refinedTitle, verb: input.proposedVerb } : entry,
            ),
          ]),
        ) as BoardDoc['lanes'],
      };
      return Promise.resolve({ ...verb(id, input.refinedTitle, 'groomed'), verb: input.proposedVerb });
    },
    groom: () => Promise.resolve({ id: 'g', title: 'g' }),
    move: () => Promise.resolve({ id: 'm', title: 'm' }),
    reorder: () => Promise.resolve({ id: 'r', title: 'r' }),
    block: (_p, id, reason) => {
      calls.push(`block:${id}:${reason ?? ''}`);
      return Promise.resolve({ id, title: id });
    },
    unblock: (_p, id) => {
      calls.push(`unblock:${id}`);
      return Promise.resolve({ id, title: id });
    },
    tweak: () => Promise.resolve({ id: 't', title: 't', lane: 'active', requirement: 'r' }),
    demote: () => Promise.resolve({ id: 'd', title: 'd' }),
  };
  return { api, calls };
}

const silentSubscribe = (() => ({ stop() {} })) as unknown as typeof import('../../src/ui/slices/board/sse.ts').subscribeBoardEvents;

let win: ReturnType<typeof installDom>;
const mountedHosts: HTMLElement[] = []; // unmounted in afterAll — see disposeDnd
let seq = 0;

async function mount(doc: BoardDoc = DOC): Promise<{ host: HTMLElement; calls: string[] }> {
  seq += 1;
  const { api, calls } = makeApi(doc);
  const host = win.document.createElement('div') as unknown as HTMLElement;
  mountedHosts.push(host);
  host.setAttribute('data-crud-mount', String(seq));
  win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  navigate(`/p${seq}/`);
  render(<Board project={`p${seq}`} api={api} subscribe={silentSubscribe} />, host);
  await new Promise((resolve) => setTimeout(resolve, 80));
  return { host, calls };
}

function click(el: Element | null | undefined): void {
  (el as unknown as HTMLElement).click();
}

beforeAll(() => {
  win = installDom();
  startRouter();
});

afterAll(() => {
  // orphaned Boards re-render when later files navigate — unmount first, then
  // zero pdd's usage ledger (see disposeDnd in dnd.ts)
  for (const host of mountedHosts) render(null, host);
  disposeDnd();
});

describe('rename flow', () => {
  test('detail dialog Rename… → save → PATCH updateCard, title updates', async () => {
    const { host, calls } = await mount();
    click(host.querySelector('[data-id="n1"]'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Rename…')));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const input = host.querySelector('#rename-title') as unknown as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('typo note'); // prefilled
    input.value = 'fixed note';
    input.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Save')));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toContain('updateCard:n1:fixed note');
  });

  test('card menu on a todo note offers Edit title… and Delete…', async () => {
    const { host } = await mount();
    const noteCard = host.querySelector('[data-id="n1"]')!;
    click(noteCard.querySelector('.menu-btn'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const items = [...host.querySelectorAll('.menu-item')].map((el) => el.textContent);
    expect(items).toContain('Edit title…');
    expect(items).toContain('Delete…');
  });
});

describe('delete flow', () => {
  test('confirm sends DELETE and the card disappears; cancel is inert', async () => {
    const { host, calls } = await mount();
    click(host.querySelector('[data-id="k1"]'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Delete…')));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('cannot be undone');
    click([...dialog.querySelectorAll('button')].find((b) => b.textContent?.includes('Cancel')));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.filter((call) => call.startsWith('deleteCard:'))).toEqual([]);
    expect(host.querySelector('[data-id="k1"]')).not.toBeNull();

    // reopen the card (the editor replaced its detail dialog) and confirm for real
    click(host.querySelector('[data-id="k1"]'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Delete…')));
    await new Promise((resolve) => setTimeout(resolve, 60));
    click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Delete permanently')));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toContain('deleteCard:k1');
    expect(host.querySelector('[data-id="k1"]')).toBeNull();
  });
});

describe('groom re-edit flow', () => {
  test('detail Edit groom… opens prefilled; save PATCHes updateGroom', async () => {
    const { host, calls } = await mount();
    click(host.querySelector('[data-id="v1"]'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Edit groom…')));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Save changes'); // edit-mode CTA
    const verbSelect = dialog.querySelector('#groom-verb') as unknown as HTMLSelectElement;
    expect(verbSelect.value).toBe('feat'); // prefilled from the card
    const title = dialog.querySelector('#groom-title') as unknown as HTMLInputElement;
    expect(title.value).toBe('engine core');
    const tasks = [...dialog.querySelectorAll('textarea')].map((el) => (el as unknown as HTMLTextAreaElement).value);
    expect(tasks.some((value) => value.includes('task one'))).toBe(true);
    expect(dialog.querySelector('#groom-questions')).toBeNull(); // no gate in edit mode

    title.value = 'engine core revised';
    title.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    click([...dialog.querySelectorAll('button')].find((b) => b.textContent?.includes('Save changes')));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toContain('updateGroom:v1:engine core revised');
  });
});

describe('quick block on engine lanes', () => {
  test('active card carries a hold control that POSTs block', async () => {
    const { host, calls } = await mount();
    const activeCard = host.querySelector('.lane[data-lane="active"] [data-id="a1"]')!;
    const hold = activeCard.querySelector('.quick-block') as unknown as HTMLElement | null;
    expect(hold).not.toBeNull();
    hold!.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls.some((call) => call.startsWith('block:a1:'))).toBe(true);
  });
});

describe('sidebar git section', () => {
  test('renders branch/head/commits on load and refresh re-fetches', async () => {
    const { host, calls } = await mount();
    expect(calls).toContain('fetchGit'); // on-load digest
    const git = host.querySelector('.sidebar-git')!;
    expect(git.textContent).toContain('main');
    expect(git.textContent).toContain('abc1234');
    expect(git.textContent).toContain('first commit');
    expect(git.textContent).toContain('2 dirty');
    click(git.querySelector('.icon-btn[aria-label="refresh git facts"]'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.filter((call) => call === 'fetchGit').length).toBe(2); // manual refresh
  });

  test('hides facts when the project is not a git repo', async () => {
    const doc: BoardDoc = { ...DOC };
    const { api } = makeApi(doc);
    api.fetchGit = () => Promise.resolve({ repo: false, recent: [] });
    const host = win.document.createElement('div') as unknown as HTMLElement;
    mountedHosts.push(host);
    win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
    seq += 1;
    navigate(`/p${seq}/`);
    render(<Board project={`p${seq}`} api={api} subscribe={silentSubscribe} />, host);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const git = host.querySelector('.sidebar-git')!;
    expect(git.textContent).toContain('not a git repository');
    expect(git.querySelector('.git-branch')).toBeNull();
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { Home } from '../../src/ui/slices/home/Home.tsx';
import { Board } from '../../src/ui/slices/board/Board.tsx';
import type { BoardApi } from '../../src/ui/slices/board/api.ts';
import type { BoardDoc } from '../../src/ui/slices/board/api.ts';
import { navigate, startRouter } from '../../src/ui/router';
import { route } from '../../src/ui/router';
import { installDom } from './dom.ts';

// Skeleton contract (spec: ui/skeletons): chrome renders real — lane heads
// with real labels, real page title — only data shimmers (.skel, never an
// accent); success removes every bone; error shows the callout, not bones.

const EMPTY: BoardDoc = { lanes: { todo: [], groomed: [], active: [], verify: [], done: [] } };

function makeApi(fetchBoard: BoardApi['fetchBoard']): BoardApi {
  return {
    listProjects: () => Promise.resolve({ projects: [] }),
    fetchBoard,
    fetchTodo: () => Promise.resolve({ view: 'todo', cards: [] }),
    fetchNext: () => Promise.resolve({ cardId: 'v1', title: 't', verb: 'feat', context: 'c' }),
    addNote: () => Promise.reject(new Error('unused')),
    groom: () => Promise.reject(new Error('unused')),
    move: () => Promise.reject(new Error('unused')),
    reorder: () => Promise.reject(new Error('unused')),
    block: () => Promise.reject(new Error('unused')),
    unblock: () => Promise.reject(new Error('unused')),
    tweak: () => Promise.reject(new Error('unused')),
    demote: () => Promise.reject(new Error('unused')),
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
  } as BoardApi;
}

const silent = (() => ({ stop() {} })) as unknown as typeof import('../../src/ui/slices/board/sse.ts').subscribeBoardEvents;

const realFetch = globalThis.fetch;
afterEach(() => {
  route.value = { project: null, view: 'kanban', card: null };
  globalThis.fetch = realFetch;
});

describe('home skeletons', () => {
  test('pending fetch shows bones under the real title', async () => {
    const win = installDom();
    const container = win.document.createElement('div');
    win.document.body.appendChild(container as Parameters<typeof win.document.body.appendChild>[0]);
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    render(<Home />, container);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(container.querySelector('h1.page')?.textContent).toBe('workspace');
    const status = container.querySelector('[role="status"][aria-label="loading projects"]');
    expect(status).not.toBeNull();
    expect(status!.querySelectorAll('.skel').length).toBeGreaterThan(0);
  });

  test('resolved fetch renders projects and zero bones', async () => {
    const win = installDom();
    const container = win.document.createElement('div');
    win.document.body.appendChild(container as Parameters<typeof win.document.body.appendChild>[0]);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          projects: [
            {
              name: 'deck',
              path: '/x/deck',
              createdAt: '2026-08-01T10:00:00.000Z',
              activeCount: 1,
              doneCount: 2,
              lastActivity: new Date().toISOString(),
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    render(<Home />, container);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(container.textContent).toContain('deck');
    expect(container.querySelectorAll('.skel').length).toBe(0);
  });

  test('failed fetch shows the error callout, never a skeleton', async () => {
    const win = installDom();
    const container = win.document.createElement('div');
    win.document.body.appendChild(container as Parameters<typeof win.document.body.appendChild>[0]);
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    render(<Home />, container);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(container.querySelector('.c-danger')).not.toBeNull();
    expect(container.querySelectorAll('.skel').length).toBe(0);
  });
});

describe('board skeleton', () => {
  test('pending board shows five real lane heads with bone cards', async () => {
    const win = installDom('http://localhost/proj/');
    startRouter();
    navigate('/proj/');
    const container = win.document.createElement('div');
    win.document.body.appendChild(container as Parameters<typeof win.document.body.appendChild>[0]);
    render(<Board project="proj" api={makeApi(() => new Promise<BoardDoc>(() => {}))} subscribe={silent} />, container);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const status = container.querySelector('[role="status"][aria-label="loading board"]');
    expect(status).not.toBeNull();
    // real chrome: all five lane heads with real labels, semantic lane classes
    for (const lane of ['todo', 'groomed', 'active', 'verify', 'done']) {
      expect(status!.querySelector(`.lane[data-lane="${lane}"]`)).not.toBeNull();
      expect(status!.querySelector(`.lane[data-lane="${lane}"] .lane-head`)?.textContent).toContain(lane);
    }
    // ragged bone counts 3/2/1/2/1 and at least one bone card
    const counts = [...status!.querySelectorAll('.lane')].map((lane) => lane.querySelectorAll('.skel-card').length);
    expect(counts).toEqual([3, 2, 1, 2, 1]);
    expect(status!.querySelectorAll('.skel').length).toBeGreaterThan(0);
  });

  test('loaded board renders cards and zero bones', async () => {
    const win = installDom('http://localhost/proj/');
    startRouter();
    navigate('/proj/');
    const container = win.document.createElement('div');
    win.document.body.appendChild(container as Parameters<typeof win.document.body.appendChild>[0]);
    const doc: BoardDoc = {
      lanes: {
        todo: [{ id: 'n1', title: 'a note', tasks: [], progress: '0/0', research: { codebaseFindings: [] } }],
        groomed: [],
        active: [],
        verify: [],
        done: [],
      } as BoardDoc['lanes'],
    };
    render(<Board project="proj" api={makeApi(() => Promise.resolve(doc))} subscribe={silent} />, container);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(container.textContent).toContain('a note');
    expect(container.querySelectorAll('.skel').length).toBe(0);
  });
});

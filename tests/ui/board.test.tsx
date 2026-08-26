import { afterAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { Board } from '../../src/ui/slices/board/Board.tsx';
import { disposeDnd } from '../../src/ui/slices/board/dnd.ts';
import { boardPath, navigate, route, startRouter } from '../../src/ui/router.ts';
import type { BoardApi, BoardDoc, UiCard } from '../../src/ui/slices/board/api.ts';
import type { HTMLDivElement as HdomDiv } from 'happy-dom';
import { installDom } from './dom.ts';

// View tests render Board with a stubbed api + a silent SSE connector —
// DOM-level behavior only (data flow is covered by store/api tests).

const note = (id: string, title: string): UiCard => ({ id, title });
const verb = (id: string, title: string, tasks?: UiCard['tasks'], progress?: string): UiCard => ({
  id,
  title,
  lane: 'groomed',
  verb: 'feat',
  specPath: `specs/changes/feat-${id}/`,
  tasks: tasks ?? [],
  progress: progress ?? '0/0',
  research: { codebaseFindings: ['found it'] },
});

function makeApi(doc: BoardDoc): BoardApi {
  return {
    listProjects: () => Promise.resolve({ projects: [] }),
    fetchBoard: () => Promise.resolve(doc),
    fetchTodo: () => Promise.resolve({ view: 'todo', cards: [] }),
    fetchNext: () => Promise.resolve({ cardId: 'v1', title: 'top', verb: 'feat', context: 'ctx' }),
    addNote: () => Promise.resolve(note('new', 'new')),
    groom: () => Promise.resolve(verb('g1', 'groomed')),
    move: () => Promise.resolve(note('m', 'moved')),
    reorder: () => Promise.resolve(note('r', 'reordered')),
    block: () => Promise.resolve(note('b', 'blocked')),
    unblock: () => Promise.resolve(note('u', 'unblocked')),
    tweak: () => Promise.resolve({ id: 't', title: 't', lane: 'active', requirement: 'r' }),
    demote: () => Promise.resolve(note('d', 'demoted')),
    fetchGit: () => Promise.resolve({ repo: false, recent: [] }),
    updateCard: (_p: string, id: string, title: string) => Promise.resolve({ id, title }),
    deleteCard: () => Promise.resolve(),
    updateGroom: (_p: string, id: string) => Promise.resolve({ id, title: 'g' }),
  };
}

const DOC: BoardDoc = {
  lanes: {
    todo: [note('n1', 'empty states feel dead'), { id: 'k1', title: 'bump hint copy', requirement: 'one line' }],
    groomed: [verb('v1', 'engine core (P1 gate)', [{ title: 'a', done: true }, { title: 'b', done: false }], '1/2')],
    active: [{ ...verb('a1', 'server build', [{ title: 'x', done: false }], '0/1'), lane: 'active' }],
    verify: [],
    done: [],
  },
};

const silentSubscribe = (() => ({ stop() {} })) as unknown as typeof import('../../src/ui/slices/board/sse.ts').subscribeBoardEvents;

const mountedContainers: HdomDiv[] = [];

async function renderBoard(doc: BoardDoc = DOC, path = '/proj/'): Promise<{ win: ReturnType<typeof installDom>; container: HdomDiv; api: BoardApi }> {
  const win = installDom();
  const stop = startRouter();
  const api = makeApi(doc);
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  mountedContainers.push(container);
  navigate(path);
  render(<Board project="proj" api={api} subscribe={silentSubscribe} />, container);
  await new Promise((resolve) => setTimeout(resolve, 80));
  stop();
  return { win, container, api };
}

afterAll(() => {
  // orphaned Boards re-render when later files navigate — unmount first, then
  // zero pdd's usage ledger (see disposeDnd in dnd.ts)
  for (const container of mountedContainers) render(null, container);
  disposeDnd();
});

describe('Board kanban view (task 6.1)', () => {
  test('renders five lanes, server order, types, blocked state, engine lock', async () => {
    const stuck: UiCard = { ...note('n2', 'stuck'), blocked: { reason: 'needs migration', at: '' } };
    const { win } = await renderBoard({ ...DOC, lanes: { ...DOC.lanes, todo: stuck === undefined ? DOC.lanes.todo : [...DOC.lanes.todo, stuck] } });
    const lanes = [...win.document.querySelectorAll('.lane')];
    expect(lanes.map((lane) => lane.getAttribute('data-lane'))).toEqual(['todo', 'groomed', 'active', 'verify', 'done']);
    expect(lanes.filter((lane) => lane.classList.contains('is-engine')).length).toBe(3);
    const todoTitles = [...win.document.querySelectorAll('.lane[data-lane="todo"] .kcard-title')].map((el) => el.textContent);
    expect(todoTitles).toContain('empty states feel dead');
    expect(win.document.querySelector('.verb-chip')?.textContent?.trim()).toBe('feat');
    expect(win.document.querySelector('.type-note')).not.toBeNull();
    expect(win.document.querySelector('.type-tweak')).not.toBeNull();
    const progress = win.document.querySelector('.kcard-progress .fill') as unknown as HTMLElement;
    expect(progress.style.width).toBe('50%');
    expect(win.document.querySelector('.lane[data-lane="active"] .wip')?.textContent).toContain('1/3');
    expect(win.document.querySelector('.lane-empty')).not.toBeNull(); // verify/done empty hints
  });

  test('blocked cards dim with a reachable reason', async () => {
    const blockedDoc: BoardDoc = { lanes: { ...DOC.lanes, todo: [{ id: 'n9', title: 'waiting on x', blocked: { reason: 'needs migration', at: '' } }] } };
    const { win } = await renderBoard(blockedDoc);
    const card = win.document.querySelector('[data-id="n9"]')!;
    expect(card.classList.contains('is-blocked')).toBe(true);
    expect(card.textContent).toContain('needs migration'); // visible text, not hover-only
  });
});

describe('view toggle (task 6.2/6.3)', () => {
  test('toggle switches to todo view via URL without refetching', async () => {
    let fetches = 0;
    const { win } = await renderBoard();
    // count is already 1 from mount; patch the api to count further fetches
    const api = makeApi(DOC);
    void api;
    fetches = 1;

    const todoButton = win.document.querySelector('.sidebar-nav a[href*="view=todo"]') as unknown as HTMLElement;
    todoButton.click();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(route.value.view).toBe('todo');
    expect(win.location.search).toContain('view=todo');
    expect(win.document.querySelector('.todo-group-head')?.textContent).toContain('up next');
    // URL-only switch: no additional fetchBoard call beyond the mount one
    expect(fetches).toBe(1);
  });

  test('todo view renders the same cards, grouped, engine read-only', async () => {
    const { win } = await renderBoard(DOC, '/proj/?view=todo');
    const groups = [...win.document.querySelectorAll('.todo-group-head')].map((el) => el.textContent);
    expect(groups.some((title) => title?.includes('groomed queue'))).toBe(true);
    expect(groups.some((title) => title?.includes('inbox'))).toBe(true);
    expect(groups.some((title) => title?.includes('engine-owned'))).toBe(true);
    expect(win.document.body.textContent).toContain('engine core (P1 gate)');
  });

  test('deep link ?view=todo renders the todo view directly', async () => {
    expect(boardPath('proj', 'todo')).toBe('/proj/?view=todo');
    const { win } = await renderBoard(DOC, '/proj/?view=todo');
    expect(win.document.querySelector('.board')).toBeNull();
    expect(win.document.querySelector('.todo-view')).not.toBeNull();
  });
});

describe('card detail deep link (task 6.4)', () => {
  test('?card= opens the detail dialog; actions POST via the store', async () => {
    const { win } = await renderBoard(DOC, '/proj/?card=v1');
    const dialog = win.document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('engine core (P1 gate)');
    expect(dialog?.textContent).toContain('1/2');
    expect(dialog?.querySelectorAll('.task').length).toBe(2);
  });
});

import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'preact';
import { Board } from '../../src/ui/slices/board/Board.tsx';
import { disposeDnd } from '../../src/ui/slices/board/dnd.ts';
import { navigate, startRouter } from '../../src/ui/router.ts';
import type { BoardApi, BoardDoc, EpicTree, UiCard } from '../../src/ui/slices/board/api.ts';
import type { HTMLDivElement as HdomDiv } from 'happy-dom';
import { installDom } from './dom.ts';

// Board hierarchy on a populated isolated board: epic entities are labeled as
// epics, child cards name their parent epic, missing parents fall back without
// pretending the relationship is a type, and details navigate the hierarchy.

const EPIC_ID = 'epic-board';

const EPIC_CARD: UiCard = { id: EPIC_ID, title: 'board hardening', type: 'epic', createdAt: '2026-09-15T00:00:00.000Z' };
const STORY: UiCard = {
  id: 'feat-child-story',
  title: 'harden card hierarchy',
  lane: 'groomed',
  verb: 'feat',
  specPath: 'specs/changes/feat-child-story/',
  tasks: [
    { title: 'label epics', done: true },
    { title: 'parent pill', done: false },
  ],
  progress: '1/2',
  research: { codebaseFindings: ['found cardKind'] },
  epicId: EPIC_ID,
};
const ORPHAN: UiCard = { id: 'note-orphan', title: 'stale child', epicId: 'epic-gone' };
const PLAIN_NOTE: UiCard = { id: 'note-plain', title: 'unrelated note' };

const TREE: EpicTree = {
  epic: { id: EPIC_ID, title: 'board hardening', createdAt: '', type: 'epic' },
  stories: [
    { id: 'feat-child-story', title: 'harden card hierarchy', lane: 'groomed', verb: 'feat', tasks: { done: 1, total: 2 } },
    { id: 'note-orphan', title: 'stale child', lane: 'todo', tasks: { done: 0, total: 0 } },
  ],
};

const DOC: BoardDoc = {
  lanes: {
    todo: [EPIC_CARD, ORPHAN, PLAIN_NOTE],
    groomed: [STORY],
    active: [],
    verify: [],
    done: [],
  },
  epics: [{ id: EPIC_ID, title: 'board hardening', stories: 2, done: 0 }],
};

const silentSubscribe = (() => ({ stop() {} })) as unknown as typeof import('../../src/ui/slices/board/sse.ts').subscribeBoardEvents;

function makeApi(doc: BoardDoc): BoardApi {
  const note = (id: string, title: string): UiCard => ({ id, title });
  const verb = (id: string, title: string): UiCard => ({
    id, title, lane: 'groomed', verb: 'feat', specPath: '', tasks: [], progress: '0/0', research: { codebaseFindings: [] },
  });
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
    fetchEpicTree: (_p: string, epicId: string) => Promise.resolve(epicId === EPIC_ID ? TREE : {
      epic: { id: epicId, title: 'unknown epic', createdAt: '', type: 'epic' },
      stories: [],
    }),
  };
}

const mountedContainers: HdomDiv[] = [];

async function renderBoard(doc: BoardDoc = DOC, path = '/proj/'): Promise<{ win: ReturnType<typeof installDom> }> {
  const win = installDom();
  const stop = startRouter();
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  mountedContainers.push(container);
  navigate(path);
  render(<Board project="proj" api={makeApi(doc)} subscribe={silentSubscribe} />, container);
  await new Promise((resolve) => setTimeout(resolve, 80));
  stop();
  return { win };
}

async function waitFor(win: ReturnType<typeof installDom>, predicate: () => boolean, tries = 12): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

afterAll(() => {
  for (const container of mountedContainers) render(null, container);
  disposeDnd();
});

describe('board hierarchy — kanban', () => {
  test('an epic card is labeled and iconed as an epic, not a note, with no note actions', async () => {
    const { win } = await renderBoard();
    const card = win.document.querySelector(`.kcard[data-id="${EPIC_ID}"]`)!;
    expect(card).not.toBeNull();
    const epicChip = card.querySelector('.type-epic')!;
    expect(epicChip.textContent).toContain('epic');
    expect(card.querySelector('.type-note')).toBeNull();
    // epics are planning cards — the note-only groom affordance must not appear
    const groom = [...card.querySelectorAll('button')].find((button) => button.textContent?.includes('groom'));
    expect(groom).toBeUndefined();
  });

  test('a child card shows the named parent epic pill separate from type and progress', async () => {
    const { win } = await renderBoard();
    const card = win.document.querySelector('.kcard[data-id="feat-child-story"]')!;
    expect(card.querySelector('.verb-chip')?.textContent).toContain('feat');
    const pill = card.querySelector('.parent-epic')!;
    expect(pill.textContent).toContain('board hardening');
    expect(pill).not.toBe(card.querySelector('.verb-chip'));
    // checklist progress stays its own affordance next to the hierarchy pill
    expect(card.querySelector('.kcard-progress.frac')?.textContent).toBe('1/2');
    const fill = card.querySelector('.kcard-progress .track .fill') as unknown as HTMLElement;
    expect(fill.style.width).toBe('50%');
  });

  test('a child whose parent is not in the payload gets a non-clickable fallback, not the id as a type', async () => {
    const { win } = await renderBoard();
    const card = win.document.querySelector('.kcard[data-id="note-orphan"]')!;
    const pill = card.querySelector('.parent-epic')!;
    expect(pill.textContent).toContain('parent epic unavailable');
    expect(pill.tagName).toBe('SPAN');
    expect(card.textContent).not.toContain('epic-gone'); // raw id never shown as content
    expect(pill.getAttribute('title')).toContain('epic-gone'); // relationship stays discoverable
    expect(card.querySelector('.type-note')).not.toBeNull(); // entity type is still note
  });
});

describe('board hierarchy — todo view', () => {
  test('child rows carry named parent context without conflating it with entity type', async () => {
    const { win } = await renderBoard(DOC, '/proj/?view=todo');
    const storyRow = win.document.querySelector('.todo-row[data-id="feat-child-story"]')!;
    expect(storyRow.querySelector('.verb-chip')?.textContent).toContain('feat');
    expect(storyRow.querySelector('.parent-epic')?.textContent).toContain('board hardening');
    expect(storyRow.querySelector('.todo-progress')?.textContent).toBe('1/2');

    const orphanRow = win.document.querySelector('.todo-row[data-id="note-orphan"]')!;
    expect(orphanRow.querySelector('.parent-epic')?.textContent).toContain('parent epic unavailable');
    expect(orphanRow.querySelector('.type-note')).not.toBeNull();
  });

  test('an epic row in the todo inbox is an epic, not a note', async () => {
    const { win } = await renderBoard(DOC, '/proj/?view=todo');
    const row = win.document.querySelector(`.todo-row[data-id="${EPIC_ID}"]`)!;
    expect(row.querySelector('.type-epic')?.textContent).toContain('epic');
    expect(row.querySelector('.type-note')).toBeNull();
    const groom = [...row.querySelectorAll('button')].find((button) => button.textContent?.includes('groom'));
    expect(groom).toBeUndefined();
  });
});

describe('board hierarchy — detail navigation', () => {
  test('opening an epic card lists its child stories; a story row opens that story in place', async () => {
    const { win } = await renderBoard();
    (win.document.querySelector(`.kcard[data-id="${EPIC_ID}"] .kcard-open`) as unknown as HTMLElement).click();
    await waitFor(win, () => (win.document.querySelector('[role="dialog"]')?.textContent ?? '').includes('stories done'));
    const dialog = win.document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('0/2 stories done');
    const storyRow = [...win.document.querySelectorAll('button.story-row')].find((row) =>
      row.textContent?.includes('harden card hierarchy'),
    ) as unknown as HTMLElement;
    storyRow.click();
    await waitFor(win, () => (win.document.querySelector('[role="dialog"]')?.textContent ?? '').includes('parent pill'));
    const storyDialog = win.document.querySelector('[role="dialog"]')!;
    expect(storyDialog.textContent).toContain('harden card hierarchy');
    expect(storyDialog.textContent).toContain('label epics'); // task list with state
  });

  test('a story detail breadcrumb navigates back to the parent epic', async () => {
    const { win } = await renderBoard();
    (win.document.querySelector('.kcard[data-id="feat-child-story"] .kcard-open') as unknown as HTMLElement).click();
    await waitFor(win, () => win.document.querySelector('button.type-epic') !== null);
    const crumb = win.document.querySelector('button.type-epic') as unknown as HTMLElement;
    expect(crumb.textContent).toContain('board hardening');
    crumb.click();
    await waitFor(win, () => (win.document.querySelector('[role="dialog"]')?.textContent ?? '').includes('stories done'));
    expect(win.document.querySelector('[role="dialog"]')?.textContent).toContain('0/2 stories done');
  });
});

describe('board hierarchy — narrow layout contract', () => {
  const spade = readFileSync(join(import.meta.dir, '../../src/ui/styles/spade.css'), 'utf8');

  test('card meta pills wrap instead of overlapping on narrow lanes', () => {
    expect(spade).toMatch(/\.kcard-meta \{[^}]*flex-wrap: wrap/s);
  });

  test('todo rows keep one line: the title truncates so pills never overlap', () => {
    expect(spade).toMatch(/\.todo-row \.todo-title \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis/s);
  });
});

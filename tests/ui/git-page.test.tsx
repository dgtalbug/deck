import { afterAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { GitPage } from '../../src/ui/slices/board/GitPage.tsx';
import type { BoardApi, GitDigest, PullRequest } from '../../src/ui/slices/board/api.ts';
import { ApiError } from '../../src/ui/slices/board/api.ts';
import { installDom, type TestWindow } from './dom.ts';
import type { HTMLDivElement as HdomDiv } from 'happy-dom';

// GitPage against a fake api: every section, guard-disabled state, confirm
// flows, the gh-unavailable state, and the inline output block.

const mountedContainers: HdomDiv[] = [];

afterAll(() => {
  for (const container of mountedContainers) render(null, container);
});

const DIGEST: GitDigest = {
  repo: true,
  branch: 'main',
  head: 'abc1234',
  dirtyCount: 2,
  ahead: 1,
  behind: 0,
  recent: [{ sha: 'abc1234', subject: 'first' }],
  origin: 'https://example.com/x/y.git',
  branches: ['feat/x', 'main', 'topic'],
  stashCount: 1,
  gh: { available: true, account: 'tester' },
  graph: '* abc1234 (HEAD -> main) first\n* d41a3c9 c0',
  tags: ['v1.0.0'],
};

const PULLS: PullRequest[] = [
  { number: 7, title: 'do the thing', headRefName: 'feat/x', url: 'https://example.com/x/y/pull/7', isDraft: false },
];

interface Calls {
  actions: string[];
}

function makeApi(overrides: Partial<Record<keyof BoardApi, unknown>> = {}, digest: GitDigest = DIGEST): { api: BoardApi; calls: Calls } {
  const calls: Calls = { actions: [] };
  const ok = (name: string, output = `${name} output`) => () => {
    calls.actions.push(name);
    return Promise.resolve({ output });
  };
  const api = {
    listProjects: () => Promise.resolve({ projects: [] }),
    fetchBoard: () => Promise.resolve({ lanes: { todo: [], groomed: [], active: [], verify: [], done: [] } }),
    fetchTodo: () => Promise.resolve({ view: 'todo', cards: [] }),
    fetchNext: () => Promise.resolve({ cardId: 'v1', title: 't', context: 'c' }),
    fetchGit: () => Promise.resolve(digest),
    updateCard: () => Promise.resolve({ id: 'x', title: 'x' }),
    deleteCard: () => Promise.resolve(),
    updateGroom: () => Promise.resolve({ id: 'x', title: 'x' }),
    addNote: () => Promise.resolve({ id: 'x', title: 'x' }),
    groom: () => Promise.resolve({ id: 'x', title: 'x' }),
    move: () => Promise.resolve({ id: 'x', title: 'x' }),
    reorder: () => Promise.resolve({ id: 'x', title: 'x' }),
    block: () => Promise.resolve({ id: 'x', title: 'x' }),
    unblock: () => Promise.resolve({ id: 'x', title: 'x' }),
    tweak: () => Promise.resolve({ id: 'x', title: 'x' }),
    demote: () => Promise.resolve({ id: 'x', title: 'x' }),
    createBranch: ok('createBranch'),
    switchBranch: ok('switchBranch'),
    mergeBranch: ok('mergeBranch'),
    commitAll: ok('commitAll'),
    undoLastCommit: ok('undoLastCommit'),
    stashPush: ok('stashPush'),
    stashPop: ok('stashPop'),
    deleteBranch: ok('deleteBranch'),
    fetchRemote: ok('fetchRemote'),
    pullRemote: ok('pullRemote'),
    pushRemote: ok('pushRemote'),
    fetchPulls: () => {
      calls.actions.push('fetchPulls');
      return Promise.resolve(PULLS);
    },
    createPullRequest: () => {
      calls.actions.push('createPullRequest');
      return Promise.resolve({ url: 'https://example.com/x/y/pull/9' });
    },
    ...overrides,
  } as BoardApi;
  return { api, calls };
}

async function mountGitPage(api: BoardApi): Promise<TestWindow> {
  const win = installDom();
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  mountedContainers.push(container);
  render(<GitPage project="proj" api={api} />, container);
  await new Promise((resolve) => setTimeout(resolve, 80));
  return win;
}

const click = (win: TestWindow, selector: string): void => {
  (win.document.querySelector(selector) as unknown as HTMLElement).click();
};

describe('GitPage', () => {
  test('status card shows branch, dirty, stash, origin, gh badge; commit tree renders git graph', async () => {
    const { api } = makeApi();
    const win = await mountGitPage(api);
    const text = win.document.body.textContent ?? '';
    expect(text).toContain('main');
    expect(text).toContain('@abc1234');
    expect(text).toContain('2 dirty');
    expect(text).toContain('1 stashed');
    expect(text).toContain('tester');
    expect(text).toContain('first');
    expect(text).toContain('#7');
    expect(text).toContain('do the thing');
    // redesign: section grid carries the tree and the action cards side by side
    expect(win.document.querySelector('.git-section-grid .git-graph')?.textContent).toContain('(HEAD -> main)');
    expect(win.document.querySelector('.git-section-grid button[data-action="commit"]')).not.toBeNull();
  });

  test('branch list marks current; switch disabled on dirty tree with hint; delete disabled on current', async () => {
    const { api } = makeApi();
    const win = await mountGitPage(api);
    const mainRow = win.document.querySelector('.git-branch-row[data-branch="main"]');
    expect(mainRow?.querySelector('.git-current-mark')?.textContent).toBe('current');

    const dirtySwitch = win.document.querySelector('.git-branch-row[data-branch="feat/x"] button[data-action^="switch:"]') as unknown as HTMLButtonElement;
    expect(dirtySwitch.disabled).toBe(true);
    expect(dirtySwitch.title).toContain('clean');

    const deleteCurrent = mainRow?.querySelector('button[data-action^="delete:"]') as unknown as HTMLButtonElement;
    expect(deleteCurrent.disabled).toBe(true);
    expect(deleteCurrent.title).toContain('current');

    // clean tree → switch enabled and runs
    const { api: cleanApi, calls } = makeApi({}, { ...DIGEST, dirtyCount: 0 });
    const win2 = await mountGitPage(cleanApi);
    const featSwitch = win2.document.querySelector('.git-branch-row[data-branch="feat/x"] button[data-action^="switch:"]') as unknown as HTMLButtonElement;
    expect(featSwitch.disabled).toBe(false);
    featSwitch.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.actions).toContain('switchBranch');
    const output = win2.document.querySelector('[data-testid="git-output"]');
    expect(output?.getAttribute('data-kind')).toBe('ok');
    expect(output?.textContent).toContain('switchBranch output');
  });

  test('create branch form validates the name and submits base + checkout', async () => {
    const { api, calls } = makeApi();
    const win = await mountGitPage(api);
    const form = win.document.querySelector('.git-create-form') as unknown as HTMLFormElement;
    const name = form.querySelector('input[aria-label="new branch name"]') as unknown as HTMLInputElement;
    const submit = form.querySelector('button[type="submit"]') as unknown as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // empty name

    name.value = 'bad..name';
    name.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(submit.disabled).toBe(true); // mirrored guard

    name.value = 'feat/new';
    name.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(submit.disabled).toBe(false);
    (form.querySelector('select[aria-label="base branch"]') as unknown as HTMLSelectElement).value = 'topic';
    (form.querySelector('input[type="checkbox"]') as unknown as HTMLInputElement).checked = true;
    submit.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.actions).toContain('createBranch');
  });

  test('changes: commit disabled when clean; undo asks for a confirm; stash pop guarded', async () => {
    const { api, calls } = makeApi();
    const win = await mountGitPage(api);
    expect((win.document.querySelector('button[data-action="commit"]') as unknown as HTMLButtonElement).disabled).toBe(false); // dirty

    // undo-commit opens a confirm dialog; accepting runs it
    click(win, 'button[data-action="undo-commit"]');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(win.document.querySelector('[role="dialog"]')?.textContent).toContain('reset --soft');
    click(win, '[data-testid="confirm-accept"]');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.actions).toContain('undoLastCommit');

    // stash pop blocked: dirty tree (2 dirty) with a stash present
    const pop = win.document.querySelector('button[data-action="stash-pop"]') as unknown as HTMLButtonElement;
    expect(pop.disabled).toBe(true);
    expect(pop.title).toContain('clean');

    // clean tree + empty stash → still blocked, different hint
    const { api: noStash } = makeApi({}, { ...DIGEST, dirtyCount: 0, stashCount: 0 });
    const win2 = await mountGitPage(noStash);
    const pop2 = win2.document.querySelector('button[data-action="stash-pop"]') as unknown as HTMLButtonElement;
    expect(pop2.disabled).toBe(true);
    expect(pop2.title).toContain('no stash');

    // clean + stash → enabled and runs
    const { api: okApi, calls: okCalls } = makeApi({}, { ...DIGEST, dirtyCount: 0, stashCount: 1 });
    const win3 = await mountGitPage(okApi);
    const pop3 = win3.document.querySelector('button[data-action="stash-pop"]') as unknown as HTMLButtonElement;
    expect(pop3.disabled).toBe(false);
    pop3.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(okCalls.actions).toContain('stashPop');
  });

  test('merge: dirty tree disables; confirm names from → current; conflict output surfaced', async () => {
    const { api: conflictApi } = makeApi({
      mergeBranch: () => Promise.reject(new ApiError(400, 'git merge refused: conflict — merge aborted, tree restored', { output: 'CONFLICT (content): Merge conflict in a.txt' })),
    });
    const win = await mountGitPage(conflictApi);
    // dirty by default → disabled
    const mergeBtn = win.document.querySelector('button[data-action="merge"]') as unknown as HTMLButtonElement;
    expect(mergeBtn.disabled).toBe(true);

    const { api } = makeApi({
      mergeBranch: () => Promise.reject(new ApiError(400, 'git merge refused: conflict — merge aborted, tree restored', { output: 'CONFLICT (content): Merge conflict in a.txt' })),
    }, { ...DIGEST, dirtyCount: 0 });
    const win2 = await mountGitPage(api);
    const select = win2.document.querySelector('select[aria-label="merge source branch"]') as unknown as HTMLSelectElement;
    expect([...select.options].every((option) => option.value !== 'main')).toBe(true); // current excluded
    select.value = 'topic';
    select.dispatchEvent(new win2.Event('change', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const btn = win2.document.querySelector('button[data-action="merge"]') as unknown as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(win2.document.querySelector('[role="dialog"]')?.textContent).toContain('merge topic → main');
    click(win2, '[data-testid="confirm-accept"]');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const output = win2.document.querySelector('[data-testid="git-output"]');
    expect(output?.getAttribute('data-kind')).toBe('err');
    expect(output?.textContent).toContain('CONFLICT');
  });

  test('remote: fetch/pull/push; pull guarded on dirty; push confirm names branch + remote', async () => {
    const { api, calls } = makeApi();
    const win = await mountGitPage(api);
    expect((win.document.querySelector('button[data-action="pull"]') as unknown as HTMLButtonElement).disabled).toBe(true);

    click(win, 'button[data-action="fetch"]');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.actions).toContain('fetchRemote');

    click(win, 'button[data-action="push"]');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const dialog = win.document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('main');
    expect(dialog?.textContent).toContain('https://example.com/x/y.git');
    click(win, '[data-testid="confirm-accept"]');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.actions).toContain('pushRemote');
  });

  test('PR create submits title/base/draft and shows the URL; gh unavailable replaces the section', async () => {
    const { api, calls } = makeApi();
    const win = await mountGitPage(api);
    const form = win.document.querySelector('.git-card[aria-label="pull requests"] .git-create-form') as unknown as HTMLFormElement;
    const title = form.querySelector('input[aria-label="pull request title"]') as unknown as HTMLInputElement;
    title.value = 'my pr';
    title.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    (form.querySelector('button[type="submit"]') as unknown as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.actions).toContain('createPullRequest');
    expect(win.document.querySelector('[data-testid="git-output"]')?.textContent).toContain('https://example.com/x/y/pull/9');

    const { api: noGhApi, calls: noGhCalls } = makeApi({}, { ...DIGEST, gh: { available: false } });
    const win2 = await mountGitPage(noGhApi);
    // gh fallback: local repository facts replace the PR card
    const fallback = win2.document.querySelector('[data-testid="gh-fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toContain('https://example.com/x/y.git');
    expect(fallback?.textContent).toContain('v1.0.0');
    expect(win2.document.querySelector('.git-pr-list')).toBeNull();
    expect(noGhCalls.actions).not.toContain('fetchPulls');
    // other sections still render and work
    click(win2, 'button[data-action="fetch"]');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(noGhCalls.actions).toContain('fetchRemote');
  });

  test('non-repo digest shows the notice instead of the sections', async () => {
    const { api } = makeApi({}, { repo: false, recent: [] });
    const win = await mountGitPage(api);
    expect(win.document.querySelector('.git-card[aria-label="git status"]')?.textContent).toContain('not a git repository');
    expect(win.document.querySelector('.git-card[aria-label="branches"]')).toBeNull();
  });
});

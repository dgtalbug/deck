import { afterAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { GitPage } from '../../src/ui/slices/board/GitPage.tsx';
import type { BoardApi, GitDigest } from '../../src/ui/slices/board/api.ts';
import { installDom, type TestWindow } from './dom.ts';
import type { HTMLDivElement as HdomDiv } from 'happy-dom';

// Requirement: history tab renders recent commits — the digest payload that
// used to be fetched-but-unrendered (recent[], tags[], graph) is now the
// History tab: mono shas with subjects, tags as chips, the verbatim graph.
const mountedContainers: HdomDiv[] = [];

afterAll(() => {
  for (const container of mountedContainers) render(null, container);
});

const DIGEST: GitDigest = {
  repo: true,
  branch: 'main',
  head: 'abc1234',
  dirtyCount: 0,
  recent: [
    { sha: 'abc1234', subject: 'merge: epic planning containers' },
    { sha: 'bb9d621', subject: 'feat(board): epic planning' },
    { sha: '504ff1a', subject: 'fix(engine): honest messages' },
  ],
  origin: 'https://example.com/x/y.git',
  branches: ['main'],
  stashCount: 0,
  gh: { available: true, account: 'tester' },
  graph: '* abc1234 (HEAD -> main) merge: epic planning containers\n| * bb9d621 feat(board): epic planning\n|/\n* 504ff1a fix(engine): honest messages',
  tags: ['v0.6.0', 'v0.5.2'],
};

function fakeApi(digest: GitDigest): BoardApi {
  return {
    listProjects: () => Promise.resolve({ projects: [] }),
    fetchBoard: () => Promise.resolve({ lanes: { todo: [], groomed: [], active: [], verify: [], done: [] } }),
    fetchTodo: () => Promise.resolve({ view: 'todo', cards: [] }),
    fetchNext: () => Promise.resolve({ cardId: 'v1', title: 't', context: 'c' }),
    fetchGit: () => Promise.resolve(digest),
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
    createPullRequest: () => Promise.resolve({ url: 'u' }),
  } as BoardApi;
}

async function mountAtHistory(digest: GitDigest): Promise<TestWindow> {
  const win = installDom();
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  mountedContainers.push(container);
  render(<GitPage project="proj" api={fakeApi(digest)} />, container);
  await new Promise((resolve) => setTimeout(resolve, 80));
  (win.document.querySelector('[data-testid="git-tab-history"]') as unknown as HTMLElement).click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  return win;
}

describe('history tab renders recent commits', () => {
  test('every recent commit renders with its sha and subject', async () => {
    const win = await mountAtHistory(DIGEST);
    const history = win.document.querySelector('[data-testid="git-history"]');
    expect(history?.textContent).toContain('abc1234');
    expect(history?.textContent).toContain('merge: epic planning containers');
    expect(history?.textContent).toContain('bb9d621');
    expect(history?.textContent).toContain('feat(board): epic planning');
    expect(history?.textContent).toContain('504ff1a');
  });

  test('tags render as chips and the graph renders verbatim', async () => {
    const win = await mountAtHistory(DIGEST);
    expect(win.document.querySelector('[data-testid="git-tags"]')?.textContent).toContain('v0.6.0');
    expect(win.document.querySelector('[data-testid="git-tags"]')?.textContent).toContain('v0.5.2');
    expect(win.document.querySelector('.git-graph')?.textContent).toContain('(HEAD -> main)');
  });

  test('empty history states are honest, not blank', async () => {
    const { graph: _noGraph, tags: _noTags, ...bare } = DIGEST;
    void _noGraph;
    void _noTags;
    const win = await mountAtHistory({ ...bare, recent: [] });
    const history = win.document.querySelector('[data-testid="git-history"]');
    expect(history?.textContent).toContain('no commits yet');
    expect(win.document.querySelector('.git-graph')).toBeNull();
    expect(win.document.querySelector('[data-testid="git-tags"]')).toBeNull();
  });
});

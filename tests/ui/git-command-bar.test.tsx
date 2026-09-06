import { afterAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { GitPage } from '../../src/ui/slices/board/GitPage.tsx';
import type { BoardApi, GitDigest } from '../../src/ui/slices/board/api.ts';
import { installDom, type TestWindow } from './dom.ts';
import type { HTMLDivElement as HdomDiv } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// git-page redesign — the paired file for the "Git command bar"
// requirement: every digest fact as one chip row, refresh in the bar,
// not-a-repo hint stands alone.
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
  branches: ['main'],
  stashCount: 1,
  gh: { available: true, account: 'tester' },
  graph: '* abc1234 (HEAD -> main) first',
  tags: [],
};

const api = {
  fetchGit: () => Promise.resolve(DIGEST),
  fetchPulls: () => Promise.resolve([]),
} as unknown as BoardApi;

const noRepoApi = {
  fetchGit: () => Promise.resolve({ ...DIGEST, repo: false } as GitDigest),
  fetchPulls: () => Promise.resolve([]),
} as unknown as BoardApi;

async function mount(a: BoardApi): Promise<TestWindow> {
  const win = installDom();
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  mountedContainers.push(container);
  render(<GitPage project="proj" api={a} />, container);
  await new Promise((resolve) => setTimeout(resolve, 80));
  return win;
}

describe('git command bar', () => {
  test('carries branch, HEAD, dirty, ahead/behind, stash, gh badge, origin, refresh', async () => {
    const win = await mount(api);
    const bar = win.document.querySelector('.git-command-bar');
    expect(bar).not.toBeNull();
    const text = bar?.textContent ?? '';
    expect(text).toContain('main');
    expect(text).toContain('@abc1234');
    expect(text).toContain('2 dirty');
    expect(text).toContain('0');
    expect(text).toContain('stashed');
    expect(win.document.querySelector('.git-command-bar [data-testid="gh-badge"]')?.textContent).toContain('tester');
    expect(text).toContain('https://example.com/x/y.git');
    expect(bar?.querySelector('button[aria-label="refresh git facts"]')).not.toBeNull();
  });

  test('not a repo: the hint stands alone in the bar, no facts, no sections', async () => {
    const win = await mount(noRepoApi);
    const bar = win.document.querySelector('.git-command-bar');
    expect(bar?.textContent).toContain('not a git repository');
    expect(bar?.querySelector('.git-fact')).toBeNull();
    expect(win.document.querySelector('.git-section-grid')).toBeNull();
  });

  test('the stylesheet lays the bar out as a wrapping chip row', () => {
    const css = readFileSync(join(import.meta.dir, '../../src/ui/styles/app.css'), 'utf8');
    expect(css).toContain('.git-command-bar {');
    expect(css).toMatch(/\.git-command-bar \{[^}]*flex-wrap: wrap/s);
  });
});

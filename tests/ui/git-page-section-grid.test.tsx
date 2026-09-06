import { afterAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { GitPage } from '../../src/ui/slices/board/GitPage.tsx';
import type { BoardApi, GitDigest, PullRequest } from '../../src/ui/slices/board/api.ts';
import { installDom, type TestWindow } from './dom.ts';
import type { HTMLDivElement as HdomDiv } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// git-page redesign — the paired file for the "Git page section grid"
// requirement: self-sizing grid, pinned narrow order, action hooks intact.
const mountedContainers: HdomDiv[] = [];

afterAll(() => {
  for (const container of mountedContainers) render(null, container);
});

const DIGEST: GitDigest = {
  repo: true,
  branch: 'main',
  head: 'abc1234',
  dirtyCount: 1,
  ahead: 0,
  behind: 0,
  recent: [{ sha: 'abc1234', subject: 'first' }],
  origin: 'https://example.com/x/y.git',
  branches: ['feat/x', 'main'],
  stashCount: 0,
  gh: { available: true, account: 'tester' },
  graph: '* abc1234 (HEAD -> main) first',
  tags: [],
};

const PULLS: PullRequest[] = [
  { number: 7, title: 'do the thing', headRefName: 'feat/x', url: 'https://example.com/x/y/pull/7', isDraft: false },
];

const api = {
  fetchGit: () => Promise.resolve(DIGEST),
  fetchPulls: () => Promise.resolve(PULLS),
} as unknown as BoardApi;

async function mount(): Promise<TestWindow> {
  const win = installDom();
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  mountedContainers.push(container);
  render(<GitPage project="proj" api={api} />, container);
  await new Promise((resolve) => setTimeout(resolve, 80));
  return win;
}

describe('git page section grid', () => {
  test('all six sections occupy grid cells with preserved action hooks', async () => {
    const win = await mount();
    const grid = win.document.querySelector('.git-section-grid');
    expect(grid).not.toBeNull();
    // working copy action
    expect(grid?.querySelector('button[data-action="commit"]')).not.toBeNull();
    // branches
    expect(grid?.querySelector('.git-branch-row[data-branch="main"]')).not.toBeNull();
    // remote + PRs
    expect(win.document.querySelector('.git-card[aria-label="pull requests"]')?.textContent).toContain('#7');
    // history
    expect(grid?.querySelector('.git-graph')?.textContent).toContain('(HEAD -> main)');
  });

  test('narrow-viewport DOM order: working copy, branches, remote/PRs, merge, history', async () => {
    const win = await mount();
    const labels = [...(win.document.querySelector('.git-section-grid')?.children ?? [])].map(
      (child) => (child as unknown as HTMLElement).getAttribute('aria-label') ?? '',
    );
    const working = labels.findIndex((l) => l.includes('changes'));
    const branches = labels.findIndex((l) => l === 'branches');
    const remote = labels.findIndex((l) => l.includes('pull requests') || l.includes('remote'));
    const history = labels.findIndex((l) => l.includes('history') || l.includes('tree'));
    expect(working).toBeGreaterThanOrEqual(0);
    expect(branches).toBeGreaterThan(working);
    expect(remote).toBeGreaterThan(branches);
    expect(history).toBeGreaterThan(remote);
  });

  test('the stylesheet sizes cells to the viewport (auto-fit minmax 320px)', () => {
    const css = readFileSync(join(import.meta.dir, '../../src/ui/styles/app.css'), 'utf8');
    expect(css).toContain('.git-section-grid {');
    expect(css).toMatch(/repeat\(auto-fit, minmax\(320px, 1fr\)\)/);
  });
});

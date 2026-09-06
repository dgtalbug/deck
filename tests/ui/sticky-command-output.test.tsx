import { afterAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { GitPage } from '../../src/ui/slices/board/GitPage.tsx';
import { ApiError, type BoardApi, type GitDigest } from '../../src/ui/slices/board/api.ts';
import { installDom, type TestWindow } from './dom.ts';
import type { HTMLDivElement as HdomDiv } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// git-page redesign — the paired file for the "Sticky command output"
// requirement: the output block sticks to the viewport bottom, carries a
// dismiss control, and keeps the ok/err kinds.
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
  branches: ['main'],
  stashCount: 0,
  gh: { available: true, account: 'tester' },
  graph: '* abc1234 (HEAD -> main) first',
  tags: [],
};

function makeApi(commitResult: () => Promise<{ output: string }>): BoardApi {
  return {
    fetchGit: () => Promise.resolve(DIGEST),
    fetchPulls: () => Promise.resolve([]),
    commitAll: commitResult,
  } as unknown as BoardApi;
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

describe('sticky command output', () => {
  test('a failed action renders the err block, dismiss clears it', async () => {
    const api = makeApi(() => Promise.reject(new ApiError(400, 'commit refused', { output: 'exit 1' })));
    const win = await mount(api);
    (win.document.querySelector('button[data-action="commit"]') as unknown as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const block = win.document.querySelector('[data-testid="git-output"]');
    expect(block?.getAttribute('data-kind')).toBe('err');
    expect(block?.textContent).toContain('commit refused');
    // dismiss
    (block!.querySelector('.git-output-dismiss') as unknown as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(win.document.querySelector('[data-testid="git-output"]')).toBeNull();
  });

  test('a successful action renders the ok kind with the action output', async () => {
    const api = makeApi(() => Promise.resolve({ output: 'committed abc1234' }));
    const win = await mount(api);
    (win.document.querySelector('button[data-action="commit"]') as unknown as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const block = win.document.querySelector('[data-testid="git-output"]');
    expect(block?.getAttribute('data-kind')).toBe('ok');
    expect(block?.textContent).toContain('committed abc1234');
  });

  test('the stylesheet pins the block to the viewport bottom', () => {
    const css = readFileSync(join(import.meta.dir, '../../src/ui/styles/app.css'), 'utf8');
    expect(css).toMatch(/\.git-output \{[^}]*position: sticky/s);
    expect(css).toMatch(/\.git-output \{[^}]*bottom: 12px/s);
  });
});

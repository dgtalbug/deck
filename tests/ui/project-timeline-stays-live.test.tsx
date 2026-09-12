// Timeline UI stays live: rows re-render from the freshly fetched board
// state, PR rows render clickable links to GitHub.
import { describe, expect, test } from 'bun:test';
import { render } from 'preact';
import type { VNode } from 'preact';
import { installDom, type TestWindow } from './dom.ts';
import { Timeline } from '../../src/ui/slices/board/Timeline.tsx';
import type { BoardApi, TimelineView } from '../../src/ui/slices/board/api.ts';

function apiReturning(views: TimelineView[]): { api: BoardApi; calls: () => number } {
  let calls = 0;
  const api = {
    fetchTimeline: (_project: string) => {
      calls += 1;
      return Promise.resolve(views[Math.min(calls - 1, views.length - 1)]!);
    },
  } as unknown as BoardApi;
  return { api, calls: () => calls };
}

async function mount(api: BoardApi): Promise<TestWindow> {
  const win = installDom();
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  render(<Timeline project="deck" api={api} /> as VNode, container);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return win;
}

const FIRST: TimelineView = {
  view: 'timeline',
  pulls: 'ok',
  entries: [
    { at: '2026-09-12T10:00:00Z', kind: 'pr', title: 'feat: timeline ships', url: 'https://github.com/o/r/pull/56', issueNumber: 56 },
    { at: '2026-09-11T09:00:00Z', kind: 'card', title: 'card b ships', cardId: 'card-b', lane: 'active', verb: 'feat', progress: '1/2' },
  ],
};

describe('timeline view stays live', () => {
  test('PR rows render as clickable links to GitHub', async () => {
    const { api } = apiReturning([FIRST]);
    const win = await mount(api);
    const link = win.document.querySelector('a.timeline-link') as unknown as
      | { getAttribute(n: string): string | null; textContent: string | null }
      | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('https://github.com/o/r/pull/56');
    expect(link!.textContent).toContain('feat: timeline ships');
    expect(win.document.querySelectorAll('[data-testid="timeline-card"]').length).toBe(1);
  });

  test('refresh recomputes rows from the current board state', async () => {
    const updated: TimelineView = {
      ...FIRST,
      entries: [
        { at: '2026-09-12T11:00:00Z', kind: 'card', title: 'card b ships', cardId: 'card-b', lane: 'done', verb: 'feat', progress: '2/2' },
      ],
    };
    const { api, calls } = apiReturning([FIRST, updated]);
    const win = await mount(api);
    expect(win.document.body.textContent).toContain('1/2');
    const refresh = win.document.querySelector('[data-testid="timeline-refresh"]') as unknown as { dispatchEvent(e: Event): boolean };
    refresh.dispatchEvent(new win.Event('click', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls()).toBe(2);
    expect(win.document.body.textContent).toContain('2/2');
    expect(win.document.body.textContent).not.toContain('1/2');
  });

  test('gh offline surfaces the unavailable badge without failing the view', async () => {
    const { api } = apiReturning([{ view: 'timeline', entries: [], pulls: 'unavailable' }]);
    const win = await mount(api);
    expect(win.document.body.textContent).toContain('PRs unavailable');
  });
});

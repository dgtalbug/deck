// Timeline UI stays live: day-grouped feed, kind filtering, commit/PR links,
// load-more preserving expansion state — rows re-render from the freshly
// fetched board state.
import { describe, expect, test } from 'bun:test';
import { render } from 'preact';
import type { VNode } from 'preact';
import { installDom, type TestWindow } from './dom.ts';
import { Timeline, groupedByDay } from '../../src/ui/slices/board/Timeline.tsx';
import type { BoardApi, TimelineEntry, TimelineView } from '../../src/ui/slices/board/api.ts';

function apiReturning(views: TimelineView[]): { api: BoardApi; calls: () => number; limits: () => number[] } {
  let calls = 0;
  const limits: number[] = [];
  const api = {
    fetchTimeline: (_project: string, limit?: number) => {
      calls += 1;
      limits.push(limit ?? 0);
      return Promise.resolve(views[Math.min(calls - 1, views.length - 1)]!);
    },
  } as unknown as BoardApi;
  return { api, calls: () => calls, limits: () => limits };
}

async function mount(api: BoardApi): Promise<TestWindow> {
  const win = installDom();
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  render(<Timeline project="deck" api={api} /> as VNode, container);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return win;
}

const TODAY = new Date().toISOString();
const YESTERDAY = new Date(Date.now() - 86_400_000 * 1.2).toISOString();
const LAST_WEEK = new Date(Date.now() - 86_400_000 * 6).toISOString();

function entry(partial: Partial<TimelineEntry> & { at: string; kind: TimelineEntry['kind']; title: string }): TimelineEntry {
  return partial;
}

const FEED: TimelineView = {
  view: 'timeline',
  pulls: 'ok',
  sources: { pulls: 'ok', commits: 'ok' },
  entries: [
    entry({ at: TODAY, kind: 'pr', title: 'feat: timeline ships', url: 'https://github.com/o/r/pull/56', issueNumber: 56 }),
    entry({ at: TODAY, kind: 'card', title: 'card b ships', cardId: 'b', lane: 'done', verb: 'feat', progress: '2/2' }),
    entry({ at: YESTERDAY, kind: 'commit', title: 'chore: seed the repo', shortSha: 'a1b2c3d', url: 'https://github.com/o/r/commit/fullsha' }),
    entry({ at: LAST_WEEK, kind: 'epic', title: 'code intelligence', cardId: 'epic-1' }),
  ],
};

describe('timeline view stays live', () => {
  test('entries group by day; today open, older days collapsed', async () => {
    const { api } = apiReturning([FEED]);
    const win = await mount(api);
    const days = [...win.document.querySelectorAll('.timeline-day')];
    expect(days.length).toBe(3);
    // today's rows render; yesterday + last week collapsed
    expect(win.document.querySelectorAll('[data-testid="timeline-pr"]').length).toBe(1);
    expect(win.document.querySelectorAll('[data-testid="timeline-commit"]').length).toBe(0);
    // expand yesterday → commit row appears
    const head = days[1]!.querySelector('.timeline-day-head') as unknown as { dispatchEvent(e: Event): boolean };
    head.dispatchEvent(new win.Event('click', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(win.document.querySelectorAll('[data-testid="timeline-commit"]').length).toBe(1);
  });

  test('kind filter hides non-matching entries and empty days', async () => {
    const { api } = apiReturning([FEED]);
    const win = await mount(api);
    const commitFilter = win.document.querySelector('[data-testid="timeline-filter-commit"]') as unknown as { dispatchEvent(e: Event): boolean };
    commitFilter.dispatchEvent(new win.Event('click', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(win.document.querySelectorAll('.timeline-day').length).toBe(1); // only yesterday
    expect(win.document.querySelectorAll('[data-testid="timeline-commit"]').length).toBe(1);
    expect(win.document.querySelectorAll('[data-testid="timeline-pr"]').length).toBe(0);
  });

  test('PR and commit rows render as links; commits show the short sha', async () => {
    const { api } = apiReturning([FEED]);
    const win = await mount(api);
    const prLink = win.document.querySelector('[data-testid="timeline-pr"] a.timeline-link') as unknown as
      | { getAttribute(n: string): string | null; textContent: string | null }
      | null;
    expect(prLink).not.toBeNull();
    expect(prLink!.getAttribute('href')).toBe('https://github.com/o/r/pull/56');
    // expand yesterday for the commit row
    const days = [...win.document.querySelectorAll('.timeline-day')];
    const head = days[1]!.querySelector('.timeline-day-head') as unknown as { dispatchEvent(e: Event): boolean };
    head.dispatchEvent(new win.Event('click', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const commitLink = win.document.querySelector('[data-testid="timeline-commit"] a.timeline-link') as unknown as
      | { getAttribute(n: string): string | null; textContent: string | null }
      | null;
    expect(commitLink).not.toBeNull();
    expect(commitLink!.getAttribute('href')).toBe('https://github.com/o/r/commit/fullsha');
    expect(commitLink!.textContent).toContain('a1b2c3d');
    expect(commitLink!.textContent).toContain('chore: seed the repo');
  });

  test('load more fetches a deeper page without resetting day expansion', async () => {
    // a FULL first page (50 entries) is what shows the load-more button
    const page = (n: number): TimelineEntry[] =>
      Array.from({ length: n }, (_, i) =>
        entry({ at: i < 2 ? TODAY : YESTERDAY, kind: i === 0 ? 'pr' : 'card', title: `entry ${i}`, cardId: `c${i}` }),
      );
    const first: TimelineView = { ...FEED, entries: page(50) };
    const deeper: TimelineView = { ...FEED, entries: [...page(50), entry({ at: YESTERDAY, kind: 'card', title: 'older card', cardId: 'c50' })] };
    const { api, calls, limits } = apiReturning([first, deeper]);
    const win = await mount(api);
    // expand yesterday first
    const days = [...win.document.querySelectorAll('.timeline-day')];
    const head = days[1]!.querySelector('.timeline-day-head') as unknown as { dispatchEvent(e: Event): boolean };
    head.dispatchEvent(new win.Event('click', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const more = win.document.querySelector('[data-testid="timeline-load-more"]') as unknown as { dispatchEvent(e: Event): boolean };
    expect(more).not.toBeNull();
    more.dispatchEvent(new win.Event('click', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls()).toBe(2);
    expect(limits()).toEqual([50, 100]);
    // yesterday still expanded after the swap, now holding the older card too
    expect(win.document.body.textContent).toContain('older card');
    expect(win.document.body.textContent).toContain('entry 49');
  });

  test('refresh recomputes rows from the current board state', async () => {
    const updated: TimelineView = {
      ...FEED,
      entries: [entry({ at: TODAY, kind: 'card', title: 'card b ships', cardId: 'b', lane: 'done', verb: 'feat', progress: '2/2' })],
    };
    const { api, calls } = apiReturning([FEED, updated]);
    const win = await mount(api);
    expect(win.document.body.textContent).toContain('#56'); // wait, pr title
    const refresh = win.document.querySelector('[data-testid="timeline-refresh"]') as unknown as { dispatchEvent(e: Event): boolean };
    refresh.dispatchEvent(new win.Event('click', { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls()).toBe(2);
    expect(win.document.body.textContent).not.toContain('feat: timeline ships');
  });

  test('per-source degradation surfaces notices without failing the view', async () => {
    const { api } = apiReturning([{ view: 'timeline', pulls: 'unavailable', sources: { pulls: 'unavailable', commits: 'unavailable' }, entries: [] }]);
    const win = await mount(api);
    expect(win.document.body.textContent).toContain('PR events unavailable');
    expect(win.document.body.textContent).toContain('Commits unavailable');
    expect(win.document.body.textContent).toContain('No timeline events yet');
  });

  test('groupedByDay is pure: slices newest-first lists by calendar day', () => {
    const groups = groupedByDay(FEED.entries);
    expect(groups.map((group) => group.key)).toEqual(['today', 'yesterday', groups[2]!.key]);
    expect(groups[0]!.entries.length).toBe(2);
    expect(groups[1]!.entries.length).toBe(1);
  });
});

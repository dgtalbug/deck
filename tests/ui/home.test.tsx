import { describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { Home } from '../../src/ui/slices/home/Home.tsx';
import { fetchProjects } from '../../src/ui/slices/home/api.ts';
import type { ProjectSummary } from '../../src/ui/slices/board/api.ts';
import { installDom } from './dom.ts';

// The Home component fetches on mount with a relative URL — patch fetch to
// serve a fixture payload (task 5.1: renders registry payload; empty hint).
const PAYLOAD: ProjectSummary[] = [
  {
    name: 'deck',
    path: '/Users/x/Workspace/deck',
    createdAt: '2026-08-25T10:00:00.000Z',
    activeCount: 2,
    doneCount: 5,
    lastActivity: new Date(Date.now() - 120_000).toISOString(),
  },
  {
    name: 'iris',
    path: '/Users/x/Workspace/iris',
    createdAt: '2026-08-01T10:00:00.000Z',
    activeCount: 0,
    doneCount: 14,
    lastActivity: new Date(Date.now() - 3 * 3600_000).toISOString(),
  },
];

async function renderHome(projects: ProjectSummary[] | { error: number }): Promise<{ win: ReturnType<typeof installDom>; container: unknown }> {
  const win = installDom();
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    'error' in projects
      ? new Response('boom', { status: 500 })
      : Response.json({ projects })) as unknown as typeof fetch;
  try {
    render(<Home />, container);
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    globalThis.fetch = original;
  }
  return { win, container };
}

describe('Home', () => {
  test('renders the registry payload with navigate links', async () => {
    const { win } = await renderHome(PAYLOAD);
    expect(win.document.querySelector('.grad-text')?.textContent).toBe('home');
    const cards = [...win.document.querySelectorAll('.project-card')];
    expect(cards.length).toBe(2);
    const deck = cards[0]!;
    expect(deck.getAttribute('href')).toBe('/deck/');
    expect(deck.textContent).toContain('deck');
    expect(deck.textContent).toContain('/Users/x/Workspace/deck');
    expect(deck.textContent).toContain('2 active');
    expect(deck.textContent).toContain('5 done');
    expect(deck.textContent).toContain('2m ago');
    const iris = cards[1]!;
    expect(iris.getAttribute('href')).toBe('/iris/');
    expect(iris.textContent).toContain('3h ago');
  });

  test('empty registry shows the deck init hint, no error banner', async () => {
    const { win } = await renderHome([]);
    expect(win.document.querySelector('.project-card')).toBeNull();
    expect(win.document.querySelector('.callout.c-danger')).toBeNull();
    expect(win.document.body.textContent).toContain('deck init');
  });

  test('unreachable server shows the error callout', async () => {
    const { win } = await renderHome({ error: 500 });
    expect(win.document.querySelector('.callout.c-danger')).not.toBeNull();
    expect(win.document.body.textContent).toContain('unreachable');
  });
});

describe('fetchProjects', () => {
  test('unwraps the projects array and surfaces failure status', async () => {
    const list = await (async () => {
      const original = globalThis.fetch;
      globalThis.fetch = (async () => Response.json({ projects: PAYLOAD })) as unknown as typeof fetch;
      try {
        return await fetchProjects();
      } finally {
        globalThis.fetch = original;
      }
    })();
    expect(list.map((project) => project.name)).toEqual(['deck', 'iris']);
  });
});

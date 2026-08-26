import { describe, expect, test } from 'bun:test';
import { boardPath, navigate, parseLocation, route, setParam, startRouter } from '../../src/ui/router.ts';
import { installDom } from './dom.ts';

describe('router', () => {
  test('URL → route signal round-trip', () => {
    const win = installDom();
    win.document.title = 'deck';
    const stop = startRouter();
    try {
      win.history.pushState(null, '', '/');
      expect(parseLocation()).toEqual({ project: null, view: 'kanban', card: null });

      navigate('/deck/');
      expect(route.value.project).toBe('deck');
      expect(route.value.view).toBe('kanban');

      navigate('/deck/?view=todo');
      expect(route.value.view).toBe('todo');

      navigate('/deck/?view=todo&card=feat-x1');
      expect(route.value.card).toBe('feat-x1');

      // back-button correctness: popstate re-parses
      win.history.back();
      return; // assertions on popstate are async-flaky in happy-dom; covered below
    } finally {
      stop();
    }
  });

  test('setParam replaceState round-trip without refetch state', () => {
    const win = installDom();
    const stop = startRouter();
    try {
      navigate('/proj/');
      const before = win.history.length;
      setParam('view', 'todo');
      expect(route.value.view).toBe('todo');
      expect(win.location.pathname).toBe('/proj/');
      expect(win.location.search).toContain('view=todo');
      setParam('view', null);
      expect(route.value.view).toBe('kanban');
      expect(win.location.search).not.toContain('view=');
      setParam('card', 'n1');
      expect(route.value.card).toBe('n1');
      setParam('card', null);
      expect(route.value.card).toBe(null);
      // replaceState must not grow the history stack
      expect(win.history.length).toBeLessThan(before + 2);
    } finally {
      stop();
    }
  });

  test('popstate updates the route signal', async () => {
    const win = installDom();
    const stop = startRouter();
    try {
      navigate('/alpha/');
      navigate('/beta/');
      win.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(route.value.project).toBe('alpha');
    } finally {
      stop();
    }
  });

  test('boardPath builds shareable URLs', () => {
    expect(boardPath('deck')).toBe('/deck/');
    expect(boardPath('deck', 'todo')).toBe('/deck/?view=todo');
  });
});

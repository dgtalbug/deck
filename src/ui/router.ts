import { signal } from '@preact/signals';

export type BoardViewMode = 'kanban' | 'todo' | 'git' | 'timeline' | 'history';

export interface Route {
  project: string | null;
  view: BoardViewMode;
  card: string | null;
}

export const route = signal<Route>(
  typeof window === 'undefined' ? { project: null, view: 'kanban', card: null } : parseLocation(),
);

export function parseLocation(): Route {
  const { pathname, search } = window.location;
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/');
  const project = segments[0] === '' ? null : segments[0]!;
  const params = new URLSearchParams(search);
  const viewParam = params.get('view');
  return {
    project,
    view: viewParam === 'todo' || viewParam === 'git' || viewParam === 'timeline' || viewParam === 'history' ? viewParam : 'kanban',
    card: params.get('card'),
  };
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace) {
    window.history.replaceState(null, '', path);
  } else {
    window.history.pushState(null, '', path);
  }
  route.value = parseLocation();
}

export function setParam(name: 'view' | 'card', value: string | null): void {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  window.history.replaceState(null, '', url.toString());
  route.value = parseLocation();
}

export function boardPath(project: string, view: BoardViewMode = 'kanban'): string {
  return view === 'kanban' ? `/${project}/` : `/${project}/?view=${view}`;
}

export function startRouter(): () => void {
  const onPop = () => {
    route.value = parseLocation();
  };
  window.addEventListener('popstate', onPop);
  return () => window.removeEventListener('popstate', onPop);
}

import { signal } from '@preact/signals';

// Hand-rolled history + signal router (D-UI-04): two routes — `/` home and
// `/<project>/` board — with `?view=` and `?card=` params. View/card changes
// use replaceState so URLs stay shareable and back-correct without adding
// history noise. Links must keep the trailing slash on /<project>/ (Bun only
// matches that form).

export type BoardViewMode = 'kanban' | 'todo' | 'git';

export interface Route {
  project: string | null;
  view: BoardViewMode;
  card: string | null;
}

// Initialized defensively: Bun tests import modules before the DOM harness
// installs `window`; startRouter()/navigate() re-parse once it exists.
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
    view: viewParam === 'todo' || viewParam === 'git' ? viewParam : 'kanban',
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

// URL-backed view/card switches — no refetch, no duplicated state (spec:
// toggling is a view switch, zero sync).
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

// Bind popstate (back/forward). Returns a dispose fn for tests.
export function startRouter(): () => void {
  const onPop = () => {
    route.value = parseLocation();
  };
  window.addEventListener('popstate', onPop);
  return () => window.removeEventListener('popstate', onPop);
}

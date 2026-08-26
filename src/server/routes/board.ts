import { boardView, todoView } from '../../core/board/views.ts';
import { nextDigest } from '../../core/board/next.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = {
  'GET /:project/board': 'boardView',
  'GET /:project/next': 'nextDigest',
};

export function boardRoutes(registry: ProjectRegistry): RouteTable {
  return {
    '/:project/board': {
      GET: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          const url = new URL(req.url);
          if (url.searchParams.get('view') === 'todo') {
            return Response.json(todoView(store));
          }
          return Response.json(boardView(store));
        }),
    },
    '/:project/next': {
      GET: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          return Response.json(nextDigest(store));
        }),
    },
  };
}

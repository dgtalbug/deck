// Project timeline routes: one chronological read blending board cards with
// merged PR titles. `?limit=` caps the feed (default 50).
import { timelineView } from '../../core/board/timeline.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = {
  'GET /:project/timeline': 'timelineView',
};

export function timelineRoutes(registry: ProjectRegistry): RouteTable {
  return {
    '/:project/timeline': {
      GET: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          const raw = new URL(req.url).searchParams.get('limit');
          const limit = raw !== null && /^\d+$/.test(raw) ? Math.min(Number(raw), 200) : 50;
          return Response.json(await timelineView(store, limit));
        }),
    },
  };
}

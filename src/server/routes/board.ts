import { boardView, todoView } from '../../core/board/views.ts';
import { nextDigest, readyWork } from '../../core/board/next.ts';
import { summaryPage, type SummaryView } from '../../core/board/summaries.ts';
import type { Lane } from '../../core/board/types.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = {
  'GET /:project/board': 'boardView',
  'GET /:project/next': 'nextDigest',
  'GET /:project/board/summary': 'summaryPage',
};

const LANES: Lane[] = ['todo', 'groomed', 'active', 'verify', 'done'];

export function boardRoutes(registry: ProjectRegistry): RouteTable {
  return {
    '/:project/board': {
      GET: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          const url = new URL(req.url);
          const view = url.searchParams.get('view');
          if (view === 'todo') {
            return Response.json(todoView(store));
          }
          // Bounded summary pages: view=history pages retained work,
          // summary=true pages live work. The legacy full response remains
          // the compatibility path without a bounded-payload guarantee.
          if (view === 'history' || url.searchParams.get('summary') === 'true') {
            const summaryView: SummaryView = view === 'history' ? 'history' : 'live';
            const limitParam = url.searchParams.get('limit');
            const laneParam = url.searchParams.get('lane');
            const lane = laneParam !== null && LANES.includes(laneParam as Lane) ? (laneParam as Lane) : undefined;
            const limit = limitParam !== null ? Number.parseInt(limitParam, 10) : undefined;
            if (limitParam !== null && (limit === undefined || Number.isNaN(limit))) {
              return Response.json({ error: 'limit must be an integer' }, { status: 400 });
            }
            const cursor = url.searchParams.get('cursor') ?? undefined;
            try {
              const page = summaryPage(store, {
                view: summaryView,
                ...(lane !== undefined ? { lane } : {}),
                ...(limit !== undefined ? { limit } : {}),
                ...(cursor !== undefined ? { cursor } : {}),
              });
              if (page.stale) {
                return Response.json({ stale: true, revision: page.revision }, { status: 409 });
              }
              return Response.json(page);
            } catch (error) {
              return Response.json({ error: error instanceof Error ? error.message : 'invalid cursor' }, { status: 400 });
            }
          }
          return Response.json(boardView(store));
        }),
    },
    '/:project/next': {
      GET: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          const ready = new URL(req.url).searchParams.get('ready');
          return Response.json(ready !== null && ready !== '0' ? readyWork(store) : nextDigest(store));
        }),
    },
  };
}

import { collectEvidenceBundleSnapshot } from '../../core/board/evidence-bundle.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { attempt, type RouteTable } from '../http.ts';
import { projectStore } from '../stores.ts';

export const parity = {
  'GET /:project/epics/:id/evidence': 'collectEvidenceBundleSnapshot',
};

export function evidenceRoutes(registry: ProjectRegistry): RouteTable {
  return {
    '/:project/epics/:id/evidence': {
      GET: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          return Response.json(collectEvidenceBundleSnapshot(store, req.params.id!, { createdAt: new Date().toISOString() }));
        }),
    },
  };
}

import { readCurrentCapabilityStatementStatus, readCapabilityPreview } from '../../core/board/capability-projection.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { attempt, type RouteTable } from '../http.ts';
import { projectStore } from '../stores.ts';

export const parity = {
  'GET /:project/capabilities': 'readCurrentCapabilityStatementStatus',
  'GET /:project/capabilities/previews/:id': 'readCapabilityPreview',
};

export function capabilityRoutes(registry: ProjectRegistry): RouteTable {
  return {
    '/:project/capabilities': {
      GET: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          return Response.json({
            statements: readCurrentCapabilityStatementStatus(store, new Map()),
          });
        }),
    },
    '/:project/capabilities/previews/:id': {
      GET: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          const preview = readCapabilityPreview(store, req.params.id!);
          if (preview === null) return new Response('not found', { status: 404 });
          return Response.json(preview);
        }),
    },
  };
}

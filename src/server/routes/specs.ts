import { backfillSpecs, publishSpec, syncProject } from '../../core/board/publish.ts';
import { specs } from '../../core/board/specstore.ts';
import { NotFoundError } from '../../core/board/errors.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = {
  'POST /:project/cards/:id/publish': 'publishSpec',
  'GET /:project/cards/:id/specs': 'specs',
  'POST /:project/sync': 'syncProject',
  'POST /:project/backfill-specs': 'backfillSpecs',
};

// Spec-store surface (v0.4.0, additive): one-way publish (202 + queued when
// gh is offline), spec history, reconcile, and the one-time backfill. No
// events — publication is not board mutation.
export function specsRoutes(registry: ProjectRegistry): RouteTable {
  const store = (project: string) => projectStore(registry, project);
  return {
    '/:project/cards/:id/publish': {
      POST: (req) =>
        attempt(async () => {
          await req.json().catch(() => undefined);
          const outcome = await publishSpec(await store(req.params.project!), req.params.id!);
          return Response.json(outcome, { status: outcome.queued ? 202 : 200 });
        }),
    },
    '/:project/cards/:id/specs': {
      GET: (req) =>
        attempt(async () => {
          const versions = specs(await store(req.params.project!), req.params.id!);
          if (versions.length === 0) {
            // An id that is not a card 404s via getVerbItem; a card with no
            // versions yet is an empty history, not a missing resource.
            const project = registry.find(req.params.project!);
            if (project === undefined) throw new NotFoundError('project', req.params.project!);
          }
          return Response.json({ versions });
        }),
    },
    '/:project/sync': {
      POST: (req) =>
        attempt(async () => {
          await req.json().catch(() => undefined);
          const report = await syncProject(await store(req.params.project!));
          return Response.json(report);
        }),
    },
    '/:project/backfill-specs': {
      POST: (req) =>
        attempt(async () => {
          await req.json().catch(() => undefined);
          const report = await backfillSpecs(await store(req.params.project!));
          return Response.json(report);
        }),
    },
  };
}

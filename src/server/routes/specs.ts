import { backfillSpecs, publishSpec, syncProject } from '../../core/board/publish.ts';
import { specs } from '../../core/board/specstore.ts';
import { scopeAuditView, scopeShow } from '../../core/board/scope-inspect.ts';
import { NotFoundError } from '../../core/board/errors.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = {
  'POST /:project/cards/:id/publish': 'publishSpec',
  'GET /:project/cards/:id/specs': 'specs',
  'POST /:project/sync': 'syncProject',
  'POST /:project/backfill-specs': 'backfillSpecs',
  'GET /:project/scope': 'scopeShow',
};

export function specsRoutes(registry: ProjectRegistry): RouteTable {
  const store = (project: string) => projectStore(registry, project);
  return {
    '/:project/scope': {
      GET: (req) =>
        attempt(async () => {
          const target = await store(req.params.project!);
          const view = new URL(req.url).searchParams.get('view') ?? 'show';
          if (view === 'audit') return Response.json(scopeAuditView(target));
          const cardId = new URL(req.url).searchParams.get('card');
          if (cardId === null || cardId.length === 0) {
            throw new NotFoundError('card', 'missing ?card=<id> (or ?view=audit)');
          }
          return Response.json(scopeShow(target, cardId));
        }),
    },
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


import { gitDigest } from '../../core/git/digest.ts';
import { NotFoundError } from '../../core/board/errors.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = { 'GET /:project/git': 'gitDigest' };

// Local git facts for the sidebar (v0.2.0): read-only, per-request, no
// caching, no events. Non-repo projects return { repo: false } at 200.
export function gitRoutes(registry: ProjectRegistry): RouteTable {
  return {
    '/:project/git': {
      GET: (req) =>
        attempt(async () => {
          const project = registry.find(req.params.project!);
          if (project === undefined) throw new NotFoundError('project', req.params.project!);
          return Response.json(await gitDigest(project.path));
        }),
    },
  };
}

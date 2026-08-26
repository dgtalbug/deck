import { projectSummary } from '../../core/projects/summary.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { getStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = { 'GET /': 'projectSummary' };

export function homeRoutes(registry: ProjectRegistry): RouteTable {
  return {
    '/': {
      GET: () =>
        attempt(async () => {
          const projects = registry.list();
          const summaries = await Promise.all(
            projects.map(async (project) => projectSummary(await getStore(project.path), project)),
          );
          return Response.json({ projects: summaries });
        }),
    },
  };
}

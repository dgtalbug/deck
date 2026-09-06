import { z } from 'zod';
import { archiveVerb, startVerb } from '../../core/engine/verbs.ts';
import { GitOpError } from '../../core/git/errors.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = {
  'POST /:project/cards/:id/start': 'startVerb',
  'POST /:project/cards/:id/archive': 'archiveVerb',
};

export const startBody = z.object({ verb: z.enum(['feat', 'fix']) });

// Engine-event routes (v0.5.0, additive): verb start + archive over HTTP.
// Guards map per the typed errors — verb/state refusals 400, WIP 409,
// merge conflict 409, unknown ids 404 (via the shared error path).
export function engineRoutes(registry: ProjectRegistry): RouteTable {
  const store = (project: string) => projectStore(registry, project);
  return {
    '/:project/cards/:id/start': {
      POST: (req) =>
        attempt(async () => {
          const body = startBody.parse(await req.json());
          const outcome = await startVerb(await store(req.params.project!), req.params.id!, body.verb);
          return Response.json({
            card: outcome.card,
            branch: outcome.branch,
            issueNumber: outcome.issueNumber,
            queued: outcome.queued,
          });
        }),
    },
    '/:project/cards/:id/archive': {
      POST: (req) =>
        attempt(async () => {
          await req.json().catch(() => undefined);
          try {
            const outcome = await archiveVerb(await store(req.params.project!), req.params.id!);
            return Response.json({ card: outcome.card, prUrl: outcome.prUrl, issueNumber: outcome.issueNumber });
          } catch (error) {
            if (error instanceof GitOpError && /conflict/.test(error.message)) {
              return Response.json({ error: error.message, details: error.details }, { status: 409 });
            }
            throw error;
          }
        }),
    },
  };
}


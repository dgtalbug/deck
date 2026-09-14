import { z } from 'zod';
import { archiveVerb, startVerb } from '../../core/engine/verbs.ts';
import { Verb } from '../../core/board/types.ts';
import { GitOpError } from '../../core/git/errors.ts';
import { acceptHandoff, cancelHandoff, listHandoffs, offerHandoff } from '../../core/engine/handoffs.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = {
  'POST /:project/cards/:id/start': 'startVerb',
  'POST /:project/cards/:id/archive': 'archiveVerb',
  'POST /:project/cards/:id/handoffs': 'offerHandoff',
  'GET /:project/cards/:id/handoffs': 'listHandoffs',
  'POST /:project/cards/:id/handoffs/:handoffId/accept': 'acceptHandoff',
  'POST /:project/cards/:id/handoffs/:handoffId/cancel': 'cancelHandoff',
};

export const startBody = z.object({ verb: z.enum(Verb) });

export const handoffOfferBody = z.object({
  taskId: z.string().min(1).max(64),
  sender: z.string().min(1).max(64),
  recipient: z.string().min(1).max(64),
  remainingWork: z.string().max(2000).optional(),
  evidenceIds: z.array(z.string().min(1).max(128)).max(50).optional(),
});

export const handoffAcceptBody = z.object({ recipient: z.string().min(1).max(64) });
export const handoffCancelBody = z.object({ owner: z.string().min(1).max(64) });

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
            return Response.json({
              card: outcome.card,
              prUrl: outcome.prUrl,
              issueNumber: outcome.issueNumber,
              delivery: outcome.delivery,
              warnings: outcome.warnings,
            });
          } catch (error) {
            if (error instanceof GitOpError && /conflict/.test(error.message)) {
              return Response.json({ error: error.message, details: error.details }, { status: 409 });
            }
            throw error;
          }
        }),
    },
    '/:project/cards/:id/handoffs': {
      GET: (req) =>
        attempt(async () => {
          const boardStore = await store(req.params.project!);
          return Response.json(listHandoffs(boardStore, { cardId: req.params.id! }));
        }),
      POST: (req) =>
        attempt(async () => {
          const body = handoffOfferBody.parse(await req.json());
          const boardStore = await store(req.params.project!);
          return Response.json(
            offerHandoff(boardStore, {
              cardId: req.params.id!,
              taskId: body.taskId,
              sender: body.sender,
              recipient: body.recipient,
              remainingWork: body.remainingWork,
              evidenceIds: body.evidenceIds,
            }),
          );
        }),
    },
    '/:project/cards/:id/handoffs/:handoffId/accept': {
      POST: (req) =>
        attempt(async () => {
          const body = handoffAcceptBody.parse(await req.json());
          const boardStore = await store(req.params.project!);
          return Response.json(acceptHandoff(boardStore, { handoffId: req.params.handoffId!, recipient: body.recipient }));
        }),
    },
    '/:project/cards/:id/handoffs/:handoffId/cancel': {
      POST: (req) =>
        attempt(async () => {
          const body = handoffCancelBody.parse(await req.json());
          const boardStore = await store(req.params.project!);
          return Response.json(cancelHandoff(boardStore, { handoffId: req.params.handoffId!, owner: body.owner }));
        }),
    },
  };
}


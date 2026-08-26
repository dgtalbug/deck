
import { z } from 'zod';
import { convertToVerbItem, demoteToNote, tweak } from '../../core/board/groom.ts';
import { moveLane } from '../../core/board/lanes.ts';
import type { Lane } from '../../core/board/types.ts';
import { applyVerifyResult } from '../../core/board/verify.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = {
  'POST /:project/cards/:id/groom': 'convertToVerbItem',
  'POST /:project/cards/:id/move': 'moveLane',
  'POST /:project/cards/:id/reorder': 'reorder',
  'POST /:project/cards/:id/block': 'setBlocked',
  'POST /:project/cards/:id/unblock': 'setBlocked',
  'POST /:project/cards/:id/tweak': 'tweak',
  'POST /:project/cards/:id/verify': 'applyVerifyResult',
  'POST /:project/cards/:id/demote': 'demoteToNote',
};

export const groomBody = z.object({
  proposedVerb: z.enum([
    'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert',
  ]),
  refinedTitle: z.string().min(1),
  research: z.object({
    codebaseFindings: z.array(z.string()),
    rca: z.string().optional(),
    blastRadius: z.array(z.string()).optional(),
  }),
  specDeltas: z.array(
    z.object({
      op: z.enum(['ADDED', 'MODIFIED', 'REMOVED']),
      requirement: z.string(),
      text: z.string(),
    }),
  ),
  tasks: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

export const moveBody = z.object({ to: z.enum(['todo', 'groomed', 'active', 'verify', 'done']) });
export const reorderBody = z.object({ afterId: z.string().optional() });
export const blockBody = z.object({ reason: z.string().optional() });
export const verifyBody = z.object({
  result: z.enum(['clean', 'gaps']),
  newTasks: z.array(z.string()).optional(),
});

export function cardsRoutes(registry: ProjectRegistry): RouteTable {
  const routes: RouteTable = {
    '/:project/cards/:id/move': {
      POST: (req) =>
        attempt(async () => {
          const body = moveBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          const item = moveLane(store, req.params.id!, body.to as Lane, 'human');
          return Response.json(item);
        }),
    },
    '/:project/cards/:id/reorder': {
      POST: (req) =>
        attempt(async () => {
          const body = reorderBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          return Response.json(store.reorder(req.params.id!, body.afterId));
        }),
    },
    '/:project/cards/:id/block': {
      POST: (req) =>
        attempt(async () => {
          const body = blockBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          return Response.json(store.setBlocked(req.params.id!, body.reason));
        }),
    },
    '/:project/cards/:id/unblock': {
      POST: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          return Response.json(store.setBlocked(req.params.id!));
        }),
    },
    '/:project/cards/:id/verify': {
      POST: (req) =>
        attempt(async () => {
          const body = verifyBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          return Response.json(applyVerifyResult(store, req.params.id!, body.result, body.newTasks ?? []));
        }),
    },
    '/:project/cards/:id/demote': {
      POST: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          return Response.json(demoteToNote(store, req.params.id!));
        }),
    },
  };

  // Fast lanes are feature-gated by bunfig defines (project-rules rule 4).
  if (DECK_FEATURE_GROOMING) {
    routes['/:project/cards/:id/groom'] = {
      POST: (req) =>
        attempt(async () => {
          const body = groomBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          const item = convertToVerbItem(store, { ...body, noteId: req.params.id! });
          return Response.json(item);
        }),
    };
  }
  if (DECK_FEATURE_TWEAK) {
    routes['/:project/cards/:id/tweak'] = {
      POST: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          return Response.json(tweak(store, req.params.id!));
        }),
    };
  }
  return routes;
}

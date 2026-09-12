
import { z } from 'zod';
import { convertToVerbItem, demoteToNote, tweak } from '../../core/board/groom.ts';
import { deleteCard, updateCard, updateGroom } from '../../core/board/crud.ts';
import { moveLane } from '../../core/board/lanes.ts';
import type { Lane } from '../../core/board/types.ts';
import { runVerification } from '../../core/engine/verify.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = {
  'PATCH /:project/cards/:id': 'updateCard',
  'DELETE /:project/cards/:id': 'deleteCard',
  'PATCH /:project/cards/:id/groom': 'updateGroom',
  'POST /:project/cards/:id/groom': 'convertToVerbItem',
  'POST /:project/cards/:id/move': 'moveLane',
  'POST /:project/cards/:id/reorder': 'reorder',
  'POST /:project/cards/:id/block': 'setBlocked',
  'POST /:project/cards/:id/unblock': 'setBlocked',
  'POST /:project/cards/:id/tweak': 'tweak',
  'POST /:project/cards/:id/verify': 'runVerification',
  'POST /:project/cards/:id/demote': 'demoteToNote',
};

export const groomBody = z.object({
  // Any well-formed verb name parses here; convertToVerbItem refuses names
  // that are neither built-in nor registered through `deck workflow`.
  proposedVerb: z.string().regex(/^[a-z][a-z0-9-]*$/),
  refinedTitle: z.string().min(1),
  research: z.object({
    codebaseFindings: z.array(z.string()),
    rca: z.string().optional(),
    blastRadius: z.array(z.string()).optional(),
    story: z.string().optional(),
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
export const updateBody = z.object({ title: z.string().min(1) });
// The explicit-result schema for the CLI's --result flag (and the shape the
// MCP task_sync tool accepts). The HTTP route runs the COMPUTED converge
// loop instead (like MCP `verify` and the CLI default) — a client-chosen
// result would bypass computeGaps.
export const verifyBody = z.object({
  result: z.enum(['clean', 'gaps']),
  newTasks: z.array(z.string()).optional(),
});

export function cardsRoutes(registry: ProjectRegistry): RouteTable {
  const routes: RouteTable = {
    '/:project/cards/:id': {
      PATCH: (req) =>
        attempt(async () => {
          const body = updateBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          return Response.json(updateCard(store, req.params.id!, { title: body.title }));
        }),
      DELETE: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          deleteCard(store, req.params.id!);
          return new Response(null, { status: 204 });
        }),
    },
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
          await req.json().catch(() => undefined);
          const store = await projectStore(registry, req.params.project!);
          const outcome = await runVerification(store, req.params.id!);
          return Response.json({ card: outcome.card, result: outcome.result, gaps: outcome.gaps });
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
      // v0.2.0 re-edit of an already-groomed item (no openQuestions gate)
      PATCH: (req) =>
        attempt(async () => {
          const body = groomBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          return Response.json(updateGroom(store, req.params.id!, { ...body, noteId: req.params.id! }));
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

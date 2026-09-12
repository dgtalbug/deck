// Spec-type registry routes (spec-type-registry): the registry is board
// state — the UI type editor and the groom form read it live over HTTP.
import { z } from 'zod';
import { listSpecTypes, upsertSpecType, removeSpecType } from '../../core/board/types-registry.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = {
  'GET /:project/types': 'listSpecTypes',
  'PUT /:project/types': 'upsertSpecType',
  'DELETE /:project/types/:id': 'removeSpecType',
};

const sectionBody = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1),
  alwaysRequired: z.boolean().optional(),
  requiredAboveRadius: z.number().int().min(0).optional(),
});

export const typeBody = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  displayName: z.string().min(1),
  icon: z.string().default('circle-dot'),
  sections: z.array(sectionBody).default([]),
  groomFields: z.array(z.string()).default(['story', 'findings', 'blast']),
  taskLaw: z.string().default(''),
  gitConvention: z.object({ commitPrefix: z.string().optional() }).default({}),
  hardRule: z.enum(['test-pairing']).nullable().default(null),
});

export function typesRoutes(registry: ProjectRegistry): RouteTable {
  return {
    '/:project/types': {
      GET: (_req) =>
        attempt(async () => {
          const store = await projectStore(registry, _req.params.project!);
          return Response.json(listSpecTypes(store));
        }),
      PUT: (req) =>
        attempt(async () => {
          const body = typeBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          return Response.json(upsertSpecType(store, body));
        }),
    },
    '/:project/types/:id': {
      DELETE: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          removeSpecType(store, req.params.id!);
          return new Response(null, { status: 204 });
        }),
    },
  };
}

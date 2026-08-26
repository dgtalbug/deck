
import { z } from 'zod';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = { 'POST /:project/notes': 'addNote' };

export const noteBody = z.object({ title: z.string().min(1) });

export function notesRoutes(registry: ProjectRegistry): RouteTable {
  return {
    '/:project/notes': {
      POST: (req) =>
        attempt(async () => {
          const body = noteBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          const note = store.addNote(body.title);
          return Response.json(note, { status: 201 });
        }),
    },
  };
}

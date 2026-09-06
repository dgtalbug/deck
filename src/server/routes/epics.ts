import { z } from 'zod';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';
import { epicRollups } from '../../core/board/views.ts';

// Epic planning routes: create epics, attach/detach stories, list with
// rollup. Epics are planning cards — never engine lanes.
export const parity = {
  'POST /:project/epics': 'addEpic',
  'GET /:project/epics': 'listEpics',
  'POST /:project/cards/:id/epic': 'setEpic',
};

export const epicBody = z.object({ title: z.string().min(1) });
export const attachBody = z.object({ epicId: z.string().min(1).nullable() });

export function epicsRoutes(registry: ProjectRegistry): RouteTable {
  return {
    '/:project/epics': {
      POST: (req) =>
        attempt(async () => {
          const body = epicBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          return Response.json(store.addEpic(body.title), { status: 201 });
        }),
      GET: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          return Response.json({ epics: epicRollups(store) });
        }),
    },
    '/:project/cards/:id/epic': {
      POST: (req) =>
        attempt(async () => {
          const body = attachBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          return Response.json(store.setEpic(req.params.id!, body.epicId));
        }),
    },
  };
}



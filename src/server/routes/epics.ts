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
  'GET /:project/epics/:id': 'getEpic',
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
    '/:project/epics/:id': {
      GET: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          const epic = store.getEpic(req.params.id!); // typed 404 for non-epics
          const stories = store.epicStories(req.params.id!).map((story) => ({
            id: story.id,
            title: story.title,
            lane: 'lane' in story ? story.lane : 'todo',
            verb: 'verb' in story ? story.verb : undefined,
            tasks:
              'tasks' in story
                ? { done: story.tasks.filter((task) => task.done).length, total: story.tasks.length }
                : { done: 0, total: 0 },
          }));
          return Response.json({ epic, stories });
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



import { z } from 'zod';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';
import { epicRollups } from '../../core/board/views.ts';
import {
  acknowledgeParent,
  deferCriterion,
  epicPlanning,
  linkCriterion,
  listDependencies,
  setDependencies,
  setEpicIntent,
} from '../../core/board/planning.ts';

// Epic planning routes: create epics, attach/detach stories, list with
// rollup. Epics are planning cards — never engine lanes.
export const parity = {
  'POST /:project/epics': 'addEpic',
  'GET /:project/epics': 'listEpics',
  'GET /:project/epics/:id': 'getEpic',
  'PUT /:project/epics/:id': 'setEpicIntent',
  'GET /:project/epics/:id/planning': 'epicPlanning',
  'POST /:project/epics/:id/criteria/link': 'linkCriterion',
  'POST /:project/epics/:id/criteria/defer': 'deferCriterion',
  'POST /:project/cards/:id/epic': 'setEpic',
  'POST /:project/cards/:id/epic/acknowledge': 'acknowledgeParent',
  'GET /:project/cards/:id/deps': 'listDependencies',
  'PUT /:project/cards/:id/deps': 'setDependencies',
};

export const epicBody = z.object({ title: z.string().min(1) });
export const attachBody = z.object({ epicId: z.string().min(1).nullable() });
// E03 planning authoring (board/store): revision-checked mutations.
export const intentBody = z.object({
  intent: z.string().min(1),
  criteria: z.array(z.object({ id: z.string().optional(), title: z.string().min(1) })).default([]),
  expectedRevision: z.number().int().min(0).optional(),
});
export const linkBody = z.object({ criterionId: z.string().min(1), childId: z.string().min(1) });
export const deferBody = z.object({ criterionId: z.string().min(1), reason: z.string().min(1) });
export const ackBody = z.object({ expectedRevision: z.number().int().min(0).optional() });
export const depsBody = z.object({
  dependsOn: z.array(z.string().min(1)).default([]),
  expectedRevision: z.number().int().min(0).optional(),
});

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
      // Revision-checked intent authoring: intent + criteria in one mutation.
      PUT: (req) =>
        attempt(async () => {
          const body = intentBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          setEpicIntent(store, req.params.id!, {
            intent: body.intent,
            criteria: body.criteria.flatMap((criterion) =>
              criterion.id === undefined ? [{ title: criterion.title }] : [{ id: criterion.id, title: criterion.title }],
            ),
            expectedRevision: body.expectedRevision,
          });
          return Response.json(epicPlanning(store, req.params.id!));
        }),
    },
    '/:project/epics/:id/planning': {
      GET: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          store.getEpic(req.params.id!); // typed 404 for non-epics
          return Response.json(epicPlanning(store, req.params.id!));
        }),
    },
    '/:project/epics/:id/criteria/link': {
      POST: (req) =>
        attempt(async () => {
          const body = linkBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          linkCriterion(store, req.params.id!, body.criterionId, body.childId);
          return Response.json(epicPlanning(store, req.params.id!));
        }),
    },
    '/:project/epics/:id/criteria/defer': {
      POST: (req) =>
        attempt(async () => {
          const body = deferBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          deferCriterion(store, req.params.id!, body.criterionId, body.reason);
          return Response.json(epicPlanning(store, req.params.id!));
        }),
    },
    '/:project/cards/:id/epic/acknowledge': {
      POST: (req) =>
        attempt(async () => {
          const body = ackBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          acknowledgeParent(store, req.params.id!, body.expectedRevision);
          const card = store.getCard(req.params.id!);
          const epicId = 'epicId' in card ? card.epicId : undefined;
          return Response.json(epicId === undefined ? { acknowledged: true } : epicPlanning(store, epicId));
        }),
    },
    '/:project/cards/:id/deps': {
      GET: (req) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          return Response.json({ deps: listDependencies(store, req.params.id!) });
        }),
      PUT: (req) =>
        attempt(async () => {
          const body = depsBody.parse(await req.json());
          const store = await projectStore(registry, req.params.project!);
          const card = setDependencies(store, req.params.id!, body.dependsOn, body.expectedRevision);
          return Response.json(card);
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



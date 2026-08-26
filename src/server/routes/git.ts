
import { z } from 'zod';
import { gitDigest } from '../../core/git/digest.ts';
import {
  commitAll,
  createBranch,
  createPullRequest,
  deleteBranch,
  fetchRemote,
  listPullRequests,
  mergeBranch,
  pullRemote,
  pushRemote,
  stashPop,
  stashPush,
  switchBranch,
  undoLastCommit,
} from '../../core/git/ops.ts';
import { NotFoundError } from '../../core/board/errors.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = {
  'GET /:project/git': 'gitDigest',
  'POST /:project/git/branch': 'createBranch',
  'POST /:project/git/switch': 'switchBranch',
  'POST /:project/git/merge': 'mergeBranch',
  'POST /:project/git/commit': 'commitAll',
  'POST /:project/git/undo-commit': 'undoLastCommit',
  'POST /:project/git/stash': 'stashPush',
  'POST /:project/git/stash/pop': 'stashPop',
  'POST /:project/git/branch/delete': 'deleteBranch',
  'POST /:project/git/fetch': 'fetchRemote',
  'POST /:project/git/pull': 'pullRemote',
  'POST /:project/git/push': 'pushRemote',
  'GET /:project/git/pulls': 'listPullRequests',
  'POST /:project/git/pulls': 'createPullRequest',
};

export const branchBody = z.object({
  name: z.string().min(1),
  base: z.string().optional(),
  checkout: z.boolean().optional(),
});
export const switchBody = z.object({ name: z.string().min(1) });
export const mergeBody = z.object({ from: z.string().min(1) });
export const commitBody = z.object({ message: z.string().optional() });
export const stashBody = z.object({ message: z.string().optional() });
export const pullsBody = z.object({
  title: z.string().min(1),
  base: z.string().optional(),
  draft: z.boolean().optional(),
});

// Local git facts for the sidebar (v0.2.0) + guarded git writes (v0.3.0):
// per-request, no caching, no events. Non-repo projects collapse the digest
// to { repo: false } at 200; write ops fail with git's own refusal.
export function gitRoutes(registry: ProjectRegistry): RouteTable {
  const resolve = (name: string): string => {
    const project = registry.find(name);
    if (project === undefined) throw new NotFoundError('project', name);
    return project.path;
  };
  return {
    '/:project/git': {
      GET: (req) =>
        attempt(async () => {
          return Response.json(await gitDigest(resolve(req.params.project!)));
        }),
    },
    '/:project/git/branch': {
      POST: (req) =>
        attempt(async () => {
          const body = branchBody.parse(await req.json());
          return Response.json(await createBranch(resolve(req.params.project!), body));
        }),
    },
    '/:project/git/switch': {
      POST: (req) =>
        attempt(async () => {
          const body = switchBody.parse(await req.json());
          return Response.json(await switchBranch(resolve(req.params.project!), body.name));
        }),
    },
    '/:project/git/merge': {
      POST: (req) =>
        attempt(async () => {
          const body = mergeBody.parse(await req.json());
          return Response.json(await mergeBranch(resolve(req.params.project!), body.from));
        }),
    },
    '/:project/git/commit': {
      POST: (req) =>
        attempt(async () => {
          const body = commitBody.parse(await req.json());
          return Response.json(await commitAll(resolve(req.params.project!), body.message));
        }),
    },
    '/:project/git/undo-commit': {
      POST: (req) =>
        attempt(async () => {
          await req.json().catch(() => undefined);
          return Response.json(await undoLastCommit(resolve(req.params.project!)));
        }),
    },
    '/:project/git/stash': {
      POST: (req) =>
        attempt(async () => {
          const body = stashBody.parse(await req.json().catch(() => ({})));
          return Response.json(await stashPush(resolve(req.params.project!), body.message));
        }),
    },
    '/:project/git/stash/pop': {
      POST: (req) =>
        attempt(async () => {
          await req.json().catch(() => undefined);
          return Response.json(await stashPop(resolve(req.params.project!)));
        }),
    },
    '/:project/git/branch/delete': {
      POST: (req) =>
        attempt(async () => {
          const body = switchBody.parse(await req.json());
          return Response.json(await deleteBranch(resolve(req.params.project!), body.name));
        }),
    },
    '/:project/git/fetch': {
      POST: (req) =>
        attempt(async () => {
          await req.json().catch(() => undefined);
          return Response.json(await fetchRemote(resolve(req.params.project!)));
        }),
    },
    '/:project/git/pull': {
      POST: (req) =>
        attempt(async () => {
          await req.json().catch(() => undefined);
          return Response.json(await pullRemote(resolve(req.params.project!)));
        }),
    },
    '/:project/git/push': {
      POST: (req) =>
        attempt(async () => {
          await req.json().catch(() => undefined);
          return Response.json(await pushRemote(resolve(req.params.project!)));
        }),
    },
    '/:project/git/pulls': {
      GET: (req) =>
        attempt(async () => {
          return Response.json(await listPullRequests(resolve(req.params.project!)));
        }),
      POST: (req) =>
        attempt(async () => {
          const body = pullsBody.parse(await req.json());
          return Response.json(await createPullRequest(resolve(req.params.project!), body));
        }),
    },
  };
}

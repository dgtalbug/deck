import { z } from 'zod';
import { join } from 'node:path';
import { DECK_VERSION } from '../version.ts';
import { blockBody, groomBody, moveBody, reorderBody, updateBody } from './routes/cards.ts';
import { noteBody } from './routes/notes.ts';
import { branchBody, commitBody, mergeBody, pullsBody, stashBody, switchBody } from './routes/git.ts';
import { startBody } from './routes/engine.ts';

// OpenAPI 3.1 document generated from the same zod schemas that validate
// request bodies — one source of truth, no doc drift, no extra dependency.
// Served at /openapi.json with a Scalar UI at /docs (CDN asset).
function schema(body: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(body, { target: 'openApi31' }) as Record<string, unknown>;
}

function jsonResponse(description: string): Record<string, unknown> {
  return { description };
}

function requestBody(body: z.ZodType): Record<string, unknown> {
  return {
    required: true,
    content: { 'application/json': { schema: schema(body) } },
  };
}

const errorResponses = {
  '400': { description: 'LaneViolation, GitOpError/InvalidBranchError, or invalid body (details in message)' },
  '404': { description: 'Unknown project or card id' },
  '409': { description: 'WipLimitError — active lane is at its WIP limit' },
  '503': { description: 'GhUnavailableError — gh CLI missing or unauthenticated (PR routes only)' },
} as const;

const emptyBody = z.object({});

function post(summary: string, body: z.ZodType, parameters: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    post: {
      summary,
      parameters,
      requestBody: requestBody(body),
      responses: { '200': jsonResponse('The mutated card'), ...errorResponses },
    },
  };
}

const projectParam = {
  name: 'project',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Project name as registered with deck',
} as const;

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Card id',
} as const;

function cardPath(id: string, summary: string, body: z.ZodType): [string, Record<string, unknown>] {
  return [`/{project}/cards/{id}/${id}`, post(summary, body, [projectParam, idParam])];
}

function gitPath(id: string, summary: string, body: z.ZodType): [string, Record<string, unknown>] {
  return [`/{project}/git/${id}`, post(summary, body, [projectParam])];
}

function openApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'deck board API',
      version: DECK_VERSION,
      description:
        'One deck server hosts every project. Cards move into active/verify/done ' +
        'only through engine events; human moves are todo ↔ groomed only. ' +
        'v0.3.0 adds the guarded git write routes (branch/switch/merge/commit/' +
        'undo-commit/stash/stash pop/branch delete/fetch/pull/push) and PR create/' +
        'list via gh. v0.4.0 adds the spec-store surface (publish a card spec as ' +
        'a GitHub issue with offline queueing, spec version history, project ' +
        'sync/reconcile, one-time backfill of existing specs). v0.5.0 adds the ' +
        'engine verb routes (start a feat/fix build: active + issue + guarded ' +
        'branch; archive: spec-generated PR merged, card done, issue closed) — ' +
        'all additive; no earlier route, payload, or event changed.',
    },
    servers: [{ url: 'http://127.0.0.1:3325' }],
    paths: {
      '/': {
        get: {
          summary: 'Deck home: every registered project with counts',
          responses: { '200': jsonResponse('Project list') },
        },
      },
      '/{project}/board': {
        get: {
          summary: 'Board state: lanes with ordered cards and progress badges',
          parameters: [
            projectParam,
            {
              name: 'view',
              in: 'query',
              schema: { type: 'string', enum: ['todo'] },
              description: 'Flat todo list grouped by priority instead of lanes',
            },
          ],
          responses: { '200': jsonResponse('Board view'), '404': errorResponses['404'] },
        },
      },
      '/{project}/next': {
        get: {
          summary: 'Top of the groomed queue with a ≤2k-token digest (respects WIP limit)',
          parameters: [projectParam],
          responses: { '200': jsonResponse('NextDigest'), '404': errorResponses['404'] },
        },
      },
      '/{project}/types': {
        get: {
          summary: 'Spec-type registry rows (sections, groom fields, git conventions, laws)',
          parameters: [projectParam],
          responses: { '200': jsonResponse('SpecType[]'), '404': errorResponses['404'] },
        },
        put: {
          summary: 'Create or edit a spec type (built-ins are ordinary rows)',
          parameters: [projectParam],
          responses: { '200': jsonResponse('SpecType'), '400': errorResponses['400'] },
        },
      },
      '/{project}/types/{id}': {
        delete: {
          summary: 'Remove a spec type (refuses while cards use it)',
          parameters: [projectParam, idParam],
          responses: { '204': { description: 'removed' }, '400': errorResponses['400'] },
        },
      },
      '/{project}/timeline': {
        get: {
          summary: 'Project timeline: epics, cards, task progress and merged PR titles, newest first',
          parameters: [projectParam],
          responses: { '200': jsonResponse('TimelineView'), '404': errorResponses['404'] },
        },
      },
      '/{project}/events': {
        get: {
          summary: 'SSE stream of board events (outbox-tailed; keepalive heartbeat)',
          parameters: [projectParam],
          responses: { '200': { description: 'text/event-stream' } },
        },
      },
      '/{project}/notes': post('Capture a note into the todo lane', noteBody, [projectParam]),
      '/{project}/cards/{id}': {
        patch: {
          summary: 'Rename a card (todo/groomed only — engine lanes refuse)',
          parameters: [projectParam, idParam],
          requestBody: requestBody(updateBody),
          responses: { '200': jsonResponse('The renamed card'), ...errorResponses },
        },
        delete: {
          summary: 'Hard-delete a card and its tasks (todo/groomed only)',
          parameters: [projectParam, idParam],
          responses: { '204': jsonResponse('Deleted — no content'), ...errorResponses },
        },
      },
      '/{project}/git': {
        get: {
          summary: 'Local git facts for the project path (read-only; { repo: false } when not a git repo)',
          parameters: [projectParam],
          responses: { '200': jsonResponse('GitDigest with branches, stashCount, gh status'), '404': errorResponses['404'] },
        },
      },
      ...Object.fromEntries([
        gitPath('branch', 'Create a branch (validated name; optional base, optional switch-after-create)', branchBody),
        gitPath('switch', 'Switch to an existing local branch (clean tree required)', switchBody),
        gitPath('merge', 'Merge a branch into the current branch (clean tree; auto merge --abort on conflict)', mergeBody),
        gitPath('commit', 'Commit all changes as WIP (default message when empty)', commitBody),
        gitPath('undo-commit', 'Undo the last commit with a soft reset (changes stay staged)', emptyBody),
        gitPath('stash', 'Stash push with an optional message', stashBody),
        gitPath('stash/pop', 'Stash pop (clean tree + non-empty stash required)', emptyBody),
        gitPath('branch/delete', 'Delete a branch with git -d only (never the current branch)', switchBody),
        gitPath('fetch', 'git fetch --prune from origin', emptyBody),
        gitPath('pull', 'git pull --ff-only (clean tree required)', emptyBody),
        gitPath('push', 'git push -u origin HEAD', emptyBody),
        gitPath('pulls', 'Create a pull request on the current branch via gh', pullsBody),
      ]),
      '/{project}/git/pulls': {
        get: {
          summary: 'List open pull requests via gh (503 when gh is missing or unauthenticated)',
          parameters: [projectParam],
          responses: { '200': jsonResponse('Open pull requests'), '404': errorResponses['404'], '503': errorResponses['503'] },
        },
      },
      '/{project}/cards/{id}/groom': {
        post: {
          summary: 'Accept a GroomProposal: note → verb item in groomed',
          parameters: [projectParam, idParam],
          requestBody: requestBody(groomBody),
          responses: { '200': jsonResponse('The groomed verb item'), ...errorResponses },
        },
        patch: {
          summary: 'Re-edit an already-groomed verb item (research/spec/tasks; keeps specPath)',
          parameters: [projectParam, idParam],
          requestBody: requestBody(groomBody),
          responses: { '200': jsonResponse('The updated verb item'), ...errorResponses },
        },
      },
      ...Object.fromEntries([
        cardPath('move', 'Move a card (todo ↔ groomed only for humans)', moveBody),
        cardPath('reorder', 'Midpoint insert after another card', reorderBody),
        cardPath('block', 'Flag a card blocked with a reason (no lane change)', blockBody),
        cardPath('unblock', 'Clear the blocked flag', z.object({})),
        cardPath('tweak', 'Fast lane: todo → active with one task', z.object({})),
        cardPath('verify', 'Computed converge verification (gaps → back to active with appended tasks, clean → done)', z.object({})),
        cardPath('demote', 'Reject after groom: verb item reverts to a note in todo', z.object({})),
        cardPath('publish', 'Publish the card spec as a GitHub issue (202 + queued when gh is offline)', z.object({})),
      ]),
      '/{project}/cards/{id}/specs': {
        get: {
          summary: 'Spec version history for a card (newest-first markdown blobs + checksums)',
          parameters: [projectParam, idParam],
          responses: { '200': jsonResponse('SpecVersion[]'), '404': errorResponses['404'] },
        },
      },
      '/{project}/cards/{id}/start': post('Start a verb build: engine transition to active, spec published as an issue at start, guarded branch created', startBody),
      '/{project}/cards/{id}/archive': post('Minimal archive: spec-generated PR merged --no-ff, card done, mapped issue closed, branch deleted', z.object({})),
      '/{project}/sync': post('Flush the offline publish queue and report issue-map drift (reconcile never mutates cards)', z.object({}), [projectParam]),
      '/{project}/backfill-specs': post('One-time import of openspec/specs/** into the spec store + issue publication (idempotent)', z.object({}), [projectParam]),
    },
  };
}

function docsPage(): Response {
  const html = `<!doctype html>
<html>
  <head>
    <title>deck API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
  return new Response(html, { headers: { 'content-type': 'text/html' } });
}

// Swagger UI assets come from the swagger-ui-dist devDependency (installed in
// node_modules) so the docs page works offline — no CDN.
function swaggerAsset(name: string): Response {
  return new Response(
    Bun.file(join(import.meta.dir, '../../node_modules/swagger-ui-dist', name)),
  );
}

function swaggerPage(): Response {
  const html = `<!doctype html>
<html>
  <head>
    <title>deck API — Swagger</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/swagger/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/swagger/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });
    </script>
  </body>
</html>`;
  return new Response(html, { headers: { 'content-type': 'text/html' } });
}

export const openApiRoutes: Record<string, { GET: () => Response }> = {
  '/openapi.json': { GET: () => Response.json(openApiDocument()) },
  '/docs': { GET: () => docsPage() },
  '/swagger': { GET: () => swaggerPage() },
  '/swagger/swagger-ui.css': { GET: () => swaggerAsset('swagger-ui.css') },
  '/swagger/swagger-ui-bundle.js': { GET: () => swaggerAsset('swagger-ui-bundle.js') },
  '/swagger/favicon-32x32.png': { GET: () => swaggerAsset('favicon-32x32.png') },
};

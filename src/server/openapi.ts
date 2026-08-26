import { z } from 'zod';
import { join } from 'node:path';
import { blockBody, groomBody, moveBody, reorderBody, updateBody, verifyBody } from './routes/cards.ts';
import { noteBody } from './routes/notes.ts';

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
  '400': { description: 'LaneViolation or invalid body (details in message)' },
  '404': { description: 'Unknown project or card id' },
  '409': { description: 'WipLimitError — active lane is at its WIP limit' },
} as const;

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

export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'deck board API',
      version: '0.2.0',
      description:
        'One deck server hosts every project. Cards move into active/verify/done ' +
        'only through engine events; human moves are todo ↔ groomed only. ' +
        'v0.2.0 adds card CRUD on the human lanes (PATCH/DELETE card, PATCH groom re-edit), ' +
        'the card.updated/card.deleted events, and GET /{project}/git — all additive; ' +
        'no v0.1.0 route, payload, or event changed.',
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
          responses: { '200': jsonResponse('GitDigest'), '404': errorResponses['404'] },
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
        cardPath('verify', 'Apply a VerifyResult (clean → done, gaps → back to active)', verifyBody),
        cardPath('demote', 'Reject after groom: verb item reverts to a note in todo', z.object({})),
      ]),
    },
  };
}

export function docsPage(): Response {
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

export function swaggerPage(): Response {
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

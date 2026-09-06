import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { DECK_VERSION } from '../../src/version.ts';

let server: Server<undefined>;
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'deck-oapi-home-'));
  process.env['DECK_HOME'] = home;
  server = buildServer({ registry: new ProjectRegistry() });
});

afterAll(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

describe('API docs', () => {
  test('GET /openapi.json returns a valid 3.1 document covering every route', async () => {
    const response = await fetch(`${server.url}/openapi.json`);
    expect(response.status).toBe(200);
    const doc = (await response.json()) as {
      openapi: string;
      info: { version: string };
      paths: Record<string, Record<string, unknown>>;
    };
    expect(doc.openapi).toBe('3.1.0');
    const paths = Object.keys(doc.paths);
    for (const required of [
      '/',
      '/{project}/board',
      '/{project}/next',
      '/{project}/events',
      '/{project}/git',
      '/{project}/notes',
      '/{project}/cards/{id}',
      '/{project}/cards/{id}/groom',
      '/{project}/cards/{id}/move',
      '/{project}/cards/{id}/reorder',
      '/{project}/cards/{id}/block',
      '/{project}/cards/{id}/unblock',
      '/{project}/cards/{id}/tweak',
      '/{project}/cards/{id}/verify',
      '/{project}/cards/{id}/demote',
      // v0.3.0 git write surface
      '/{project}/git/branch',
      '/{project}/git/switch',
      '/{project}/git/merge',
      '/{project}/git/commit',
      '/{project}/git/undo-commit',
      '/{project}/git/stash',
      '/{project}/git/stash/pop',
      '/{project}/git/branch/delete',
      '/{project}/git/fetch',
      '/{project}/git/pull',
      '/{project}/git/push',
      '/{project}/git/pulls',
    ]) {
      expect(paths).toContain(required);
    }
    expect(doc.info.version).toBe(DECK_VERSION);
    // v0.2.0 additions carry their methods
    const card = doc.paths['/{project}/cards/{id}'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(card)).toContain('patch');
    expect(Object.keys(card)).toContain('delete');
    const groom = doc.paths['/{project}/cards/{id}/groom'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(groom)).toContain('patch');
    // Body schemas are generated from the live zod validators.
    const move = doc.paths['/{project}/cards/{id}/move']?.['post'] as {
      requestBody: { content: Record<string, { schema: Record<string, unknown> }> };
    };
    expect(move.requestBody.content['application/json']?.schema).toBeDefined();
  });

  test('GET /docs serves the Scalar reference page', async () => {
    const response = await fetch(`${server.url}/docs`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('api-reference');
  });

  test('GET /swagger serves the Swagger UI page', async () => {
    const response = await fetch(`${server.url}/swagger`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SwaggerUIBundle');
  });
});

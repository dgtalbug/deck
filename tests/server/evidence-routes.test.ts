import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { buildServer } from '../../src/server/serve.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';
import type { Server } from 'bun';

let registry: ProjectRegistry;
let project: TmpProject;
let store: DocumentStore;
let server: Server<undefined>;
let baseUrl: string;

beforeAll(async () => {
  registry = new ProjectRegistry();
  project = tmpProject('deck-evidence-route-');
  registry.register(project.path, 'routeproj');
  store = await openStore(project.path);
  server = buildServer({ registry });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server.stop(true);
  registry.close();
  project.cleanup();
});

describe('evidence routes', () => {
  test('GET /:project/epics/:id/evidence returns a local read-only bundle', async () => {
    const epic = store.addEpic('route evidence');

    const response = await fetch(`${baseUrl}/routeproj/epics/${epic.id}/evidence`);
    const body = await response.json() as { schema: string; epics: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.schema).toBe('deck.evidence-bundle');
    expect(body.epics[0]!.id).toBe(`epic:${epic.id}`);
  });

  test('unknown epic returns 404', async () => {
    const response = await fetch(`${baseUrl}/routeproj/epics/missing/evidence`);

    expect(response.status).toBe(404);
  });
});

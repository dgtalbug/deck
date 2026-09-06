import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { tmpProject } from '../helpers.ts';
import type { Server } from 'bun';

// epic-planning — the paired file for the "Epic attach detach" requirement:
// POST /cards/:id/epic attaches and detaches; typed refusals hold.
let server: Server<undefined>;
let registry: ProjectRegistry;
let store: DocumentStore;
let baseUrl: string;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  registry = new ProjectRegistry();
  project = tmpProject('deck-epic-routes-');
  registry.register(project.path, 'epicproj');
  store = await openStore(project.path);
  server = buildServer({ registry });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server.stop(true);
  registry.close();
  project.cleanup();
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('epic attach detach', () => {
  test('create epic, attach a story, detach — round trip over HTTP', async () => {
    const created = await post('/epicproj/epics', { title: 'http epic' });
    expect(created.status).toBe(201);
    const epic = (await created.json()) as { id: string; type: string };
    expect(epic.type).toBe('epic');

    const note = store.addNote('http story');
    const attached = await post(`/epicproj/cards/${note.id}/epic`, { epicId: epic.id });
    expect(attached.status).toBe(200);
    expect(store.epicStories(epic.id)).toHaveLength(1);

    const detached = await post(`/epicproj/cards/${note.id}/epic`, { epicId: null });
    expect(detached.status).toBe(200);
    expect(store.epicStories(epic.id)).toHaveLength(0);
  });

  test('attaching to a nonexistent epic 404s; to a non-epic card 400s; self-attach 400s', async () => {
    const note = store.addNote('refusal story');
    expect((await post(`/epicproj/cards/${note.id}/epic`, { epicId: 'ghost' })).status).toBe(404);
    const other = store.addNote('not an epic');
    expect((await post(`/epicproj/cards/${note.id}/epic`, { epicId: other.id })).status).toBe(400);
    expect((await post(`/epicproj/cards/${other.id}/epic`, { epicId: other.id })).status).toBe(400);
  });

  test('GET /epics returns the rollup', async () => {
    const list = await fetch(`${baseUrl}/epicproj/epics`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { epics: Array<{ stories: number; done: number }> };
    expect(Array.isArray(body.epics)).toBe(true);
  });
});

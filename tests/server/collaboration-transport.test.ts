import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { tmpProject } from '../helpers.ts';

let server: Server<undefined>;
let registry: ProjectRegistry;
let home: string;
let project: ReturnType<typeof tmpProject>;
let baseUrl: string;

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function groomedTask(store: DocumentStore, title: string): Promise<{ cardId: string; taskId: string }> {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['implement'],
    openQuestions: [],
  });
  return { cardId: item.id, taskId: item.tasks[0]!.id };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'deck-collab-transport-home-'));
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  project = tmpProject('deck-collab-transport-');
  registry.register(project.path, 'testproj');
  server = buildServer({ registry });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server.stop(true);
  registry.close();
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

describe('collaboration transport parity', () => {
  test('assign → patch → handoff offer → accept over HTTP with parity to core results', async () => {
    const store = await openStore(project.path);
    const { cardId, taskId } = await groomedTask(store, 'transport card');

    const assignResponse = await req('POST', `/testproj/cards/${cardId}/tasks/${taskId}/assign`, { owner: 'agent-a' });
    expect(assignResponse.status).toBe(200);
    const assignment = (await assignResponse.json()) as { revision: number; owner: string };
    expect(assignment.owner).toBe('agent-a');

    const patchResponse = await req('PATCH', `/testproj/cards/${cardId}/tasks/${taskId}`, {
      expectedRevision: assignment.revision,
      owner: 'agent-a',
      commandId: 'http-1',
      done: true,
    });
    expect(patchResponse.status).toBe(200);
    const patch = (await patchResponse.json()) as { revision: number; duplicate: boolean };
    expect(patch.duplicate).toBe(false);
    expect(store.getVerbItem(cardId).tasks[0]!.done).toBe(true);

    const offerResponse = await req('POST', `/testproj/cards/${cardId}/handoffs`, {
      taskId,
      sender: 'agent-a',
      recipient: 'agent-b',
      remainingWork: 'verify the loop',
    });
    expect(offerResponse.status).toBe(200);
    const offer = (await offerResponse.json()) as { id: string; state: string };
    expect(offer.state).toBe('offered');

    const acceptResponse = await req('POST', `/testproj/cards/${cardId}/handoffs/${offer.id}/accept`, { recipient: 'agent-b' });
    expect(acceptResponse.status).toBe(200);
    const accepted = (await acceptResponse.json()) as { state: string };
    expect(accepted.state).toBe('accepted');

    const listResponse = await req('GET', `/testproj/cards/${cardId}/handoffs`);
    const list = (await listResponse.json()) as Array<{ id: string; state: string }>;
    expect(list.find((row) => row.id === offer.id)?.state).toBe('accepted');
  });

  test('stale patch over HTTP refuses without partial writes', async () => {
    const store = await openStore(project.path);
    const { cardId, taskId } = await groomedTask(store, 'stale transport card');
    await req('POST', `/testproj/cards/${cardId}/tasks/${taskId}/assign`, { owner: 'agent-a' });

    const stale = await req('PATCH', `/testproj/cards/${cardId}/tasks/${taskId}`, {
      expectedRevision: 99,
      owner: 'agent-a',
      commandId: 'http-stale',
      done: true,
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(store.getVerbItem(cardId).tasks[0]!.done).toBe(false);
    const row = store.raw().query('SELECT revision FROM task_state WHERE task_id = ?').get(taskId) as { revision: number };
    expect(row.revision).toBe(1);
  });

  test('invalid payload fails before effects', async () => {
    const store = await openStore(project.path);
    const { cardId, taskId } = await groomedTask(store, 'invalid payload card');
    const bad = await req('POST', `/testproj/cards/${cardId}/tasks/${taskId}/assign`, { owner: '' });
    expect(bad.status).toBe(400);
    const row = store.raw().query('SELECT owner FROM task_state WHERE task_id = ?').get(taskId);
    expect(row).toBeNull();
  });
});

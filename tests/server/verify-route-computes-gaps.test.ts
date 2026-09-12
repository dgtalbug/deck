import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { tmpProject } from '../helpers.ts';
import { getStore } from '../../src/core/projects/stores.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { recordSpecVersion } from '../../src/core/board/specstore.ts';

// Requirement: verify route computes gaps before closing — POST
// /cards/:id/verify runs the computed converge loop (runVerification), so a
// client-chosen {result:"clean"} can no longer close a card that has
// unchecked tasks; the route matches the MCP verify tool and CLI default.
let server: Server<undefined>;
let registry: ProjectRegistry;
let home: string;
let project: ReturnType<typeof tmpProject>;
let baseUrl: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'deck-verify-route-home-'));
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  project = tmpProject('deck-verify-route-');
  registry.register(project.path, 'verifyproj');
  server = buildServer({ registry });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server.stop(true);
  registry.close();
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function activeCardWithUncheckedTask(title: string): Promise<string> {
  const store = await getStore(project.path);
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['unchecked work item'],
    openQuestions: [],
  });
  recordSpecVersion(store, note.id, `# ${title}\n\n## ADDED Requirements\n`);
  moveLane(store, note.id, 'active', 'engine');
  return note.id;
}

describe('POST /:project/cards/:id/verify computes gaps', () => {
  test('a claimed clean result cannot close a card with unchecked tasks', async () => {
    const store = await getStore(project.path);
    const id = await activeCardWithUncheckedTask('verify route bypass card');

    // The old bypass: POST {result:"clean"} closed it sight-unseen.
    const response = await post(`/verifyproj/cards/${id}/verify`, { result: 'clean' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: 'clean' | 'gaps'; gaps: { taskTitle: string }[]; card: { lane: string } };
    expect(body.result).toBe('gaps');
    expect(body.gaps.some((gap) => gap.taskTitle === 'unchecked work item')).toBe(true);
    // the converge loop moved it back to active with the gap appended
    expect(body.card.lane).toBe('active');
    expect(store.getVerbItem(id).tasks.some((task) => task.addedByVerify === true)).toBe(true);
  });

  test('once every task is checked the same route converges clean', async () => {
    const store = await getStore(project.path);
    const id = await activeCardWithUncheckedTask('verify route converge card');
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');

    const response = await post(`/verifyproj/cards/${id}/verify`, {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: 'clean' | 'gaps'; card: { lane: string } };
    expect(body.result).toBe('clean');
    expect(body.card.lane).toBe('verify'); // clean holds for archive
  });
});

// architect-intake-navigation: GET /:project/epics/:id — the epic tree the
// board's navigation renders (epic + stories with lane + task progress),
// typed 404 for unknown or non-epic ids.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import type { Server } from 'bun';
import { tmpProject } from '../helpers.ts';
import { openStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import type { GroomProposal } from '../../src/core/board/types.ts';

let server: Server<undefined>;
let registry: ProjectRegistry;
let home: string;
let project: ReturnType<typeof tmpProject>;
let baseUrl: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'deck-epic-tree-home-'));
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  project = tmpProject('deck-epic-tree-');
  registry.register(project.path, 'epicproj');
  server = buildServer({ registry });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server.stop(true);
  registry.close();
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

function proposal(noteId: string, title: string, tasks: string[]): GroomProposal {
  return {
    noteId,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks,
    openQuestions: [],
  };
}

describe('GET /:project/epics/:id', () => {
  test('returns the epic and its stories with lane + task progress; 404s otherwise', async () => {
    const store = await openStore(project.path);
    const epic = store.addEpic('code intelligence');
    const s1 = convertToVerbItem(store, proposal(store.addNote('poc research').id, 'poc research', ['read code', 'write plan']));
    store.setEpic(s1.id, epic.id);
    const s2 = convertToVerbItem(store, proposal(store.addNote('index module').id, 'index module', ['build']));
    store.setEpic(s2.id, epic.id);
    moveLane(store, s2.id, 'done', 'engine');

    const response = await fetch(`${baseUrl}/epicproj/epics/${epic.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      epic: { id: string; title: string };
      stories: Array<{ id: string; lane: string; tasks: { done: number; total: number } }>;
    };
    expect(body.epic.id).toBe(epic.id);
    expect(body.stories.map((story) => story.id).sort()).toEqual([s1.id, s2.id].sort());
    const poc = body.stories.find((story) => story.id === s1.id)!;
    expect(poc.lane).toBe('groomed');
    expect(poc.tasks).toEqual({ done: 0, total: 2 });

    const unknown = await fetch(`${baseUrl}/epicproj/epics/no-such-epic`);
    expect(unknown.status).toBe(404);
    const nonEpic = await fetch(`${baseUrl}/epicproj/epics/${s1.id}`);
    expect(nonEpic.status).toBe(404);
  });
});

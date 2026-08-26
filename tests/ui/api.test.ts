import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { tmpProject } from '../helpers.ts';
import { ApiError, createBoardApi, type UiCard } from '../../src/ui/slices/board/api.ts';

// Every wrapper hits a live test server on an ephemeral port (task 4.1).
let server: Server<undefined>;
let registry: ProjectRegistry;
let project: ReturnType<typeof tmpProject>;
let baseUrl: string;
let boardApi: ReturnType<typeof createBoardApi>;

let previousHome: string | undefined;

beforeAll(() => {
  previousHome = process.env['DECK_HOME'];
  const home = mkdtempSync(join(tmpdir(), 'deck-ui-api-home-'));
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  project = tmpProject('deck-ui-api-');
  registry.register(project.path, 'uiproj');
  server = buildServer({ registry });
  baseUrl = server.url.toString().replace(/\/$/, '');
  boardApi = createBoardApi(baseUrl);
});

afterAll(() => {
  server.stop(true);
  registry.close();
  // The project dir leaks on purpose: the process-wide store cache keeps the
  // SQLite connection open, and deleting a WAL database under it poisons
  // later connections on macOS (SQLITE_IOERR_VNODE). tmpdir is ephemeral.
  if (previousHome === undefined) delete process.env['DECK_HOME'];
  else process.env['DECK_HOME'] = previousHome;
});

const groomInput = {
  proposedVerb: 'feat' as const,
  refinedTitle: 'groomed title',
  research: { codebaseFindings: ['found x'] },
  specDeltas: [{ op: 'ADDED' as const, requirement: 'R1', text: 'does a thing' }],
  tasks: ['one', 'two'],
  openQuestions: [],
};

describe('boardApi against a live server', () => {
  test('fetchBoard returns five lanes; fetchTodo returns the flat list', async () => {
    const board = await boardApi.fetchBoard('uiproj');
    expect(Object.keys(board.lanes).sort()).toEqual(['active', 'done', 'groomed', 'todo', 'verify']);
    const todo = await boardApi.fetchTodo('uiproj');
    expect(todo.view).toBe('todo');
    expect(Array.isArray(todo.cards)).toBe(true);
  });

  test('addNote → note in todo; fetchNext returns a digest', async () => {
    const note = await boardApi.addNote('uiproj', 'api note');
    expect(note.title).toBe('api note');
    const board = await boardApi.fetchBoard('uiproj');
    expect(board.lanes.todo.map((card) => card.id)).toContain(note.id);
    await expect(boardApi.fetchNext('uiproj')).rejects.toThrow(/groomed card/);
  });

  test('groom converts; move respects MANUAL_TRANSITIONS; reorder/block/unblock/demote work', async () => {
    const note = await boardApi.addNote('uiproj', 'to groom');
    const item = await boardApi.groom('uiproj', note.id, groomInput);
    expect(item.lane).toBe('groomed');
    expect(item.verb).toBe('feat');
    expect(item.tasks?.length).toBe(2);

    await expect(boardApi.move('uiproj', note.id, 'active')).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
    const moved = await boardApi.move('uiproj', note.id, 'todo');
    expect(moved.lane).toBe('todo');
    await boardApi.move('uiproj', note.id, 'groomed');

    const anchor = await boardApi.addNote('uiproj', 'anchor');
    await boardApi.groom('uiproj', anchor.id, { ...groomInput, refinedTitle: 'anchor' });
    const reordered = await boardApi.reorder('uiproj', anchor.id, note.id);
    expect(reordered.lane).toBe('groomed');

    const blocked = await boardApi.block('uiproj', note.id, 'waiting');
    expect(blocked.blocked?.reason).toBe('waiting');
    const unblocked = await boardApi.unblock('uiproj', note.id);
    expect(unblocked.blocked).toBeUndefined();

    const demoted = await boardApi.demote('uiproj', anchor.id);
    expect(demoted.lane ?? 'todo').toBe('todo');

    await expect(boardApi.move('uiproj', 'ghost', 'todo')).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
  });

  test('tweak moves todo → active via the response; WIP 409 surfaces as ApiError', async () => {
    const one = await boardApi.addNote('uiproj', 't1');
    const tweaked = await boardApi.tweak('uiproj', one.id);
    expect(tweaked.lane).toBe('active');
    for (const title of ['t2', 't3']) {
      const note = await boardApi.addNote('uiproj', title);
      await boardApi.tweak('uiproj', note.id);
    }
    const fourth = await boardApi.addNote('uiproj', 't4');
    await expect(boardApi.tweak('uiproj', fourth.id)).rejects.toMatchObject({ status: 409 } satisfies Partial<ApiError>);

    // at limit, next names the card to finish instead
    const digest = await boardApi.fetchNext('uiproj');
    expect(digest.wipBlockedBy).toBeDefined();
    expect(digest.context).toContain('Remaining tasks');
  });

  test('unknown project → 404 ApiError', async () => {
    await expect(boardApi.fetchBoard('nope')).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
  });

  test('UiCard progress reflects task completion', async () => {
    const note = await boardApi.addNote('uiproj', 'progress note');
    await boardApi.groom('uiproj', note.id, { ...groomInput, tasks: ['a', 'b', 'c'] });
    const board = await boardApi.fetchBoard('uiproj');
    const card: UiCard | undefined = board.lanes.groomed.find((entry) => entry.id === note.id);
    expect(card?.progress).toBe('0/3');
  });
});

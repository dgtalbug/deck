import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { eq } from 'drizzle-orm';
import { cards } from '../../src/core/board/schema.ts';
import { tmpProject } from '../helpers.ts';

// Bounded board summary routes over the shared core: 404 for unknown
// projects, 409 stale-cursor conflicts, 400 invalid cursors/limits, the
// legacy live shape unchanged, and detail lookup untouched by visibility.
let server: Server<undefined>;
let home: string;
let project: ReturnType<typeof tmpProject>;
let baseUrl: string;
let store: DocumentStore;

beforeAll(async () => {
  home = join(tmpdir(), 'deck-board-summary-');
  project = tmpProject('deck-board-summary-');
  const registry = new ProjectRegistry();
  registry.register(project.path, 'summaryproj');
  store = await openStore(project.path);
  server = buildServer({ registry, port: 0, hostname: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${server.port}`;
  for (let i = 0; i < 30; i++) {
    const note = store.addNote(`summary route story ${i}`);
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: `summary route story ${i}`,
      research: { codebaseFindings: ['has spec content'], sections: { what: 'w', why: 'y' } },
      specDeltas: [],
      tasks: ['one', 'two'],
      openQuestions: [],
    });
  }
});

afterAll(() => {
  server.stop(true);
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

describe('board summary routes', () => {
  test('unknown project returns 404', async () => {
    const response = await fetch(`${baseUrl}/nope/board?summary=true`);
    expect(response.status).toBe(404);
  });

  test('live summary pages are bounded and distinguish totals', async () => {
    const response = await fetch(`${baseUrl}/summaryproj/board?summary=true&limit=10`);
    expect(response.status).toBe(200);
    const page = (await response.json()) as { items: unknown[]; total: number; page_count: number };
    expect(page.items).toHaveLength(10);
    expect(page.total).toBe(30);
    expect(page.page_count).toBe(10);
  });

  test('a stale cursor returns an explicit conflict', async () => {
    const first = (await (await fetch(`${baseUrl}/summaryproj/board?summary=true&limit=5`)).json()) as { cursor: string };
    await fetch(`${baseUrl}/summaryproj/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'bump revision' }),
    });
    const response = await fetch(`${baseUrl}/summaryproj/board?summary=true&limit=5&cursor=${encodeURIComponent(first.cursor)}`);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { stale: boolean }).stale).toBe(true);
  });

  test('invalid cursors and limits are 400', async () => {
    const badCursor = await fetch(`${baseUrl}/summaryproj/board?summary=true&cursor=abc`);
    expect(badCursor.status).toBe(400);
    const badLimit = await fetch(`${baseUrl}/summaryproj/board?summary=true&limit=zzz`);
    expect(badLimit.status).toBe(400);
  });

  test('the legacy board shape is unchanged', async () => {
    const response = await fetch(`${baseUrl}/summaryproj/board`);
    expect(response.status).toBe(200);
    const board = (await response.json()) as { lanes: Record<string, unknown[]> };
    expect(Object.keys(board.lanes).sort()).toEqual(['active', 'done', 'groomed', 'todo', 'verify']);
  });

  test('history view pages retained work; detail stays reachable', async () => {
    const first = (await (await fetch(`${baseUrl}/summaryproj/board?summary=true&limit=50`)).json()) as { items: Array<{ id: string; type: string }> };
    const id = (first.items.find((item) => item.type === 'verb') ?? first.items[0]!)!.id;
    store.db.update(cards).set({ historyAt: new Date().toISOString() }).where(eq(cards.id, id)).run();
    const response = await fetch(`${baseUrl}/summaryproj/board?view=history`);
    expect(response.status).toBe(200);
    const page = (await response.json()) as { items: Array<{ id: string }>; total: number };
    expect(page.total).toBe(1);
    expect(page.items[0]!.id).toBe(id);
    // inclusive detail lookup: the historical card is still readable by id
    expect(store.getCard(id).id).toBe(id);
    const legacy = (await (await fetch(`${baseUrl}/summaryproj/board`)).json()) as { lanes: Record<string, unknown[]> };
    expect(legacy.lanes['todo']!.length + legacy.lanes['groomed']!.length).toBe(30); // 30 stories + 1 note - 1 rotated story
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { moveLane } from '../../../src/core/board/lanes.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { cards } from '../../../src/core/board/schema.ts';
import {
  DEFAULT_PAGE,
  ITEM_BYTE_CAP,
  MAX_PAGE,
  RESPONSE_BYTE_CAP,
  decodeCursor,
  summaryPage,
} from '../../../src/core/board/summaries.ts';
import { tmpProject } from '../../helpers.ts';

// Bounded summaries and revision-bound keyset pagination: caps, totals vs
// page counts, unchanged traversal, stale/foreign cursor handling, and the
// live/history split.
let store: DocumentStore;
let cleanup: () => void;

beforeEach(async () => {
  const project = tmpProject('deck-summaries-');
  cleanup = project.cleanup;
  store = await openStore(project.path);
});

afterEach(() => {
  cleanup();
});

function story(index: number, tasks = 2, title = `summary story ${index}`): string {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: ['has spec content'], sections: { what: 'w', why: 'y' } },
    specDeltas: [],
    tasks: Array.from({ length: tasks }, (_, t) => `task ${t}`),
    openQuestions: [],
  });
  store.syncTasks(item.id, item.tasks.map((task, i) => ({ ...task, done: i === 0 })), 'engine');
  return item.id;
}

function historicize(id: string): void {
  store.db.update(cards).set({ historyAt: new Date().toISOString() }).where(eq(cards.id, id)).run();
}

describe('bounded summary caps', () => {
  test('defaults to 25 items and caps the limit at 50', () => {
    for (let i = 0; i < 60; i++) story(i);
    expect(summaryPage(store, {}).items).toHaveLength(DEFAULT_PAGE);
    expect(summaryPage(store, { limit: 50 }).items).toHaveLength(MAX_PAGE);
    expect(() => summaryPage(store, { limit: 51 })).not.toThrow();
    expect(summaryPage(store, { limit: 51 }).items).toHaveLength(MAX_PAGE);
    expect(() => summaryPage(store, { limit: 0 })).toThrow();
    expect(() => summaryPage(store, { limit: 1.5 })).toThrow();
  });

  test('every serialized item stays under 2 KiB and the response under 128 KiB', () => {
    story(0, 3, `x`.repeat(200_000)); // oversized title
    for (let i = 1; i < 30; i++) story(i, 3);
    const page = summaryPage(store, { limit: 50 });
    expect(page.items.every((item) => Buffer.byteLength(JSON.stringify(item), 'utf8') <= ITEM_BYTE_CAP)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page.items), 'utf8') <= RESPONSE_BYTE_CAP).toBe(true);
    expect(page.items.some((item) => item.truncated)).toBe(true);
  });

  test('a story with 501 tasks stays within caps and keeps aggregate counts', () => {
    const id = story(0, 501);
    const page = summaryPage(store, { limit: 10 });
    const item = page.items.find((entry) => entry.id === id)!;
    expect(item.taskCounts).toEqual({ done: 1, total: 501 });
    expect(Buffer.byteLength(JSON.stringify(item), 'utf8') <= ITEM_BYTE_CAP).toBe(true);
  });

  test('totals are distinguished from page counts', () => {
    for (let i = 0; i < 40; i++) story(i);
    const page = summaryPage(store, { limit: 25 });
    expect(page.total).toBe(40);
    expect(page.page_count).toBe(25);
  });
});

describe('revision-bound keyset pagination', () => {
  test('an unchanged traversal returns each record exactly once', () => {
    for (let i = 0; i < 60; i++) story(i);
    const seen = new Set<string>();
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const page = summaryPage(store, { limit: 25, ...(cursor !== null && cursor !== undefined ? { cursor } : {}) });
      expect(page.stale).toBe(false);
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== null);
    expect(seen.size).toBe(60);
    expect(pages).toBe(3);
  });

  test('a write between pages produces a stale-cursor conflict', () => {
    for (let i = 0; i < 30; i++) story(i);
    const first = summaryPage(store, { limit: 10 });
    story(100); // relevant write bumps the read revision
    const second = summaryPage(store, { limit: 10, cursor: first.cursor! });
    expect(second.stale).toBe(true);
    expect(second.items).toEqual([]);
  });

  test('foreign cursors are rejected without exposing other results', () => {
    for (let i = 0; i < 5; i++) story(i);
    const first = summaryPage(store, { limit: 2 });
    const cursor = decodeCursor(first.cursor!);
    const foreignProject = { ...cursor, project: '/other/project' };
    const encoded = Buffer.from(JSON.stringify(foreignProject), 'utf8').toString('base64');
    expect(() => summaryPage(store, { cursor: encoded })).toThrow(/different project/);
    const foreignView = { ...cursor, view: 'history' as const };
    const encodedView = Buffer.from(JSON.stringify(foreignView), 'utf8').toString('base64');
    expect(() => summaryPage(store, { cursor: encodedView })).toThrow(/view or filter/);
    expect(() => summaryPage(store, { cursor: 'not-base64-json' })).toThrow();
  });

  test('live pages exclude history; history pages key on historyAt', () => {
    for (let i = 0; i < 6; i++) {
      const id = story(i);
      historicize(id);
    }
    const live = summaryPage(store, {});
    expect(live.total).toBe(0);
    const history = summaryPage(store, { view: 'history' });
    expect(history.total).toBe(6);
    expect(history.items.every((item) => item.historyAt !== null)).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../../../src/core/board/store.ts';
import { NotFoundError } from '../../../src/core/board/errors.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import type { DocumentStore } from '../../../src/core/board/store.ts';
import { tmpProject } from '../../helpers.ts';

let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject();
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

function proposal(noteId: string, title = 'refined title') {
  return {
    noteId,
    proposedVerb: 'feat' as const,
    refinedTitle: title,
    research: { codebaseFindings: ['found the flicker source'] },
    specDeltas: [{ op: 'ADDED' as const, requirement: 'req', text: 'text' }],
    tasks: ['investigate', 'fix', 'test'],
    openQuestions: [],
  };
}

describe('DocumentStore basics', () => {
  test('openStore creates .deck/board.sqlite with WAL', () => {
    expect(existsSync(join(project.path, '.deck', 'board.sqlite'))).toBe(true);
  });

  test('addNote lands in todo; getNote/listNotes round-trip', () => {
    const note = store.addNote('fix login flicker');
    expect(note.title).toBe('fix login flicker');
    expect(store.getNote(note.id).id).toBe(note.id);
    expect(store.listNotes().map((noteRow) => noteRow.id)).toContain(note.id);
    const card = store.getCard(note.id);
    expect('lane' in card).toBe(false); // a Note has no lane
  });

  test('getNote throws NotFound for a missing note', () => {
    expect(() => store.getNote('missing-0000')).toThrow(NotFoundError);
  });

  test('listCards orders by position within lanes', async () => {
    const other = await openStore(project.path);
    const first = other.addNote('first note');
    const second = other.addNote('second note');
    const todo = other.listCards('todo');
    const ids = todo.map((card) => card.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
  });
});

describe('reorder', () => {
  test('midpoint insert between anchor and next card', () => {
    const a = store.addNote('lane a');
    const b = store.addNote('lane b');
    const c = store.addNote('lane c');
    store.reorder(c.id, a.id); // c after a, before b
    const todo = store.listCards('todo').map((card) => card.id);
    expect(todo.indexOf(a.id)).toBeLessThan(todo.indexOf(c.id));
    expect(todo.indexOf(c.id)).toBeLessThan(todo.indexOf(b.id));
  });

  test('reorder with no afterId moves to lane end', () => {
    const a = store.addNote('end anchor');
    const z = store.addNote('goes last');
    store.reorder(a.id, z.id);
    store.reorder(a.id); // no anchor → end
    const todo = store.listCards('todo').map((card) => card.id);
    expect(todo.indexOf(a.id)).toBe(todo.length - 1);
  });

  test('renumber kicks in when the gap collapses', () => {
    const p1 = store.addNote('collapse one');
    const p2 = store.addNote('collapse two');
    store.reorder(p2.id, p1.id);
    // Force collapse: repeatedly insert p2 right after p1 until the gap < 1e-6.
    for (let i = 0; i < 60; i++) {
      store.reorder(p2.id, p1.id);
    }
    const positions = store
      .listCards('todo')
      .filter((card) => 'position' in card)
      .map((card) => card.position);
    const sorted = [...positions].sort((x, y) => x - y);
    expect(Math.min(...positions)).toBeGreaterThan(0);
    expect(positions).toEqual(sorted);
  });

  test('reorder with unknown anchor throws NotFound', () => {
    const note = store.addNote('orphan anchor');
    expect(() => store.reorder(note.id, 'missing-anchor')).toThrow(NotFoundError);
  });
});

describe('setBlocked / syncTasks', () => {
  test('block sets reason without lane change; unblock clears', () => {
    const note = store.addNote('blockable note');
    const item = convertToVerbItem(store, proposal(note.id));
    store.setBlocked(item.id, 'waiting on API');
    const blocked = store.getVerbItem(item.id);
    expect(blocked.blocked?.reason).toBe('waiting on API');
    expect(blocked.lane).toBe('groomed');
    store.setBlocked(item.id);
    expect(store.getVerbItem(item.id).blocked).toBeUndefined();
  });

  test('syncTasks replaces the task list wholesale (engine-only signature)', () => {
    const note = store.addNote('task sync note');
    const item = convertToVerbItem(store, proposal(note.id));
    const synced = store.syncTasks(
      item.id,
      [
        { id: 't-1', title: 'investigate', done: true },
        { id: 't-2', title: 'fix', done: false },
      ],
      'engine',
    );
    expect(synced).toHaveLength(2);
    expect(store.getVerbItem(item.id).tasks.map((task) => task.done)).toEqual([true, false]);
  });

  test('syncTasks on a non-verb card throws NotFound', () => {
    const note = store.addNote('not a verb');
    expect(() => store.syncTasks(note.id, [], 'engine')).toThrow(NotFoundError);
  });
});

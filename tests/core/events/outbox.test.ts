import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { latestRowid, readSince } from '../../../src/core/events/outbox.ts';
import { NotFoundError } from '../../../src/core/board/errors.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
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

describe('event outbox', () => {
  test('every mutation emits its event in order', () => {
    const before = latestRowid(store.db);
    const note = store.addNote('outbox note');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'outbox note',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['task'],
      openQuestions: [],
    });
    store.setBlocked(note.id, 'why');
    store.setBlocked(note.id);

    const emitted = readSince(store.db, before);
    const types = emitted.map((event) => event.type);
    expect(types).toEqual(['card.created', 'card.groomed', 'card.blocked', 'card.unblocked']);
    const created = emitted[0];
    expect(created?.payload).toEqual({ id: note.id, lane: 'todo', position: expect.any(Number) });
  });

  test('atomicity: a failed mutation leaves no event row', () => {
    const before = latestRowid(store.db);
    expect(() =>
      convertToVerbItem(store, {
        noteId: 'ghost-for-atomicity',
        proposedVerb: 'feat',
        refinedTitle: 'ghost',
        research: { codebaseFindings: [] },
        specDeltas: [],
        tasks: [],
        openQuestions: [],
      }),
    ).toThrow(NotFoundError);
    expect(readSince(store.db, before)).toEqual([]);
  });
});

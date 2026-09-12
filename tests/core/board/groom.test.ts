import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DeckError, NotFoundError } from '../../../src/core/board/errors.ts';
import { convertToVerbItem, demoteToNote, tweak } from '../../../src/core/board/groom.ts';
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

function proposal(noteId: string) {
  return {
    noteId,
    proposedVerb: 'fix' as const,
    refinedTitle: 'refined: fix the thing',
    research: { codebaseFindings: ['evidence one'], sections: { reproduce: 'steps', rca: 'cause' } },
    specDeltas: [{ op: 'ADDED' as const, requirement: 'req', text: 'text' }],
    tasks: ['investigate', 'fix it'],
    openQuestions: [],
  };
}

describe('convertToVerbItem', () => {
  test('converts the note (same id) to a verb item at the bottom of groomed', () => {
    const note = store.addNote('fix the thing');
    const earlier = store.addNote('earlier groom');
    convertToVerbItem(store, proposal(earlier.id));
    const item = convertToVerbItem(store, proposal(note.id));
    expect(item.id).toBe(note.id);
    expect(item.lane).toBe('groomed');
    expect(item.verb).toBe('fix');
    expect(item.title).toBe('refined: fix the thing');
    expect(item.specPath).toBe(`.deck/specs/tasks/fix-${note.id}/`); // shaped layout under .deck
    expect(item.tasks).toHaveLength(2);
    const groomed = store.listCards('groomed');
    expect(groomed[groomed.length - 1]?.id).toBe(item.id);
  });

  test('materializes the spec dir with a checklist', () => {
    const note = store.addNote('spec on accept');
    const item = convertToVerbItem(store, proposal(note.id));
    const specDir = join(project.path, item.specPath);
    expect(existsSync(join(specDir, 'tasks.md'))).toBe(true);
    expect(existsSync(join(specDir, 'spec.md'))).toBe(true);
  });

  test('rejects proposals with open questions', () => {
    const note = store.addNote('unclear note');
    const withQuestions = { ...proposal(note.id), openQuestions: ['which db?'] };
    expect(() => convertToVerbItem(store, withQuestions)).toThrow(DeckError);
    expect(store.getNote(note.id).title).toBe('unclear note'); // untouched
  });

  test('throws NotFound for a missing note', () => {
    expect(() => convertToVerbItem(store, proposal('ghost-note'))).toThrow(NotFoundError);
  });
});

describe('demoteToNote', () => {
  test('reverts a groomed verb item to a note in todo (same id)', () => {
    const note = store.addNote('demote me');
    const item = convertToVerbItem(store, proposal(note.id));
    const demoted = demoteToNote(store, item.id);
    expect(demoted.id).toBe(note.id);
    expect(store.getNote(note.id).id).toBe(note.id);
    expect(store.listCards('groomed').map((card) => card.id)).not.toContain(note.id);
  });

  test('refuses to demote a card that is not a groomed verb item', () => {
    const note = store.addNote('plain note');
    expect(() => demoteToNote(store, note.id)).toThrow(NotFoundError);
  });
});

describe('tweak', () => {
  test('moves a todo note directly to active with exactly one task', () => {
    const note = store.addNote('tiny fix');
    const result = tweak(store, note.id);
    expect(result.lane).toBe('active');
    expect(result.requirement).toBe('tiny fix');
    const card = store.getCard(note.id);
    expect('requirement' in card && card.requirement).toBe('tiny fix');
  });

  test('refuses a card that is not in todo', () => {
    const note = store.addNote('already groomed');
    const item = convertToVerbItem(store, proposal(note.id));
    expect(() => tweak(store, item.id)).toThrow(NotFoundError);
  });
});

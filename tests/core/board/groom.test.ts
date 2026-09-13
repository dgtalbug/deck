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

// --- E03: shared readiness (DECK-ARCH-008) + scope identity (DECK-ARCH-011) --
import { updateGroom } from '../../../src/core/board/crud.ts';
import { currentScopeRevision, scopeCriteria } from '../../../src/core/board/scope.ts';
import { StaleWriterError } from '../../../src/core/board/errors.ts';
import { recordSpecVersion, renderCardSpec } from '../../../src/core/board/specstore.ts';

describe('E03 shared readiness policy', () => {
  test('identical invalid content refuses at both doors and writes nothing (zero-write)', () => {
    const note = store.addNote('readiness equivalence');
    // story-shaped (4 tasks) without spec content → refuses at initial groom
    expect(() =>
      convertToVerbItem(store, {
        noteId: note.id,
        proposedVerb: 'feat',
        refinedTitle: 'equivalence probe',
        research: { codebaseFindings: [] },
        specDeltas: [],
        tasks: ['a', 'b', 'c', 'd'],
        openQuestions: [],
      }),
    ).toThrow(/story-shaped/);
    // the note was not consumed — groom again as ready, then attempt the
    // SAME invalid content through re-groom: identical refusal, zero writes
    const item = convertToVerbItem(store, proposal(note.id));
    const before = store.getVerbItem(item.id);
    expect(() =>
      updateGroom(store, item.id, {
        noteId: item.id,
        proposedVerb: 'feat',
        refinedTitle: 'equivalence probe',
        research: { codebaseFindings: [] },
        specDeltas: [],
        tasks: ['a', 'b', 'c', 'd'],
        openQuestions: [],
      }),
    ).toThrow(/story-shaped/);
    expect(store.getVerbItem(item.id)).toEqual(before);
  });

  test('small task proposal grooms without story narrative', () => {
    const note = store.addNote('tiny task probe');
    const item = convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'tiny task probe',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    expect(item.tasks).toHaveLength(1);
  });
});

describe('E03 scope identity through grooming', () => {
  test('no-op and reorder preserve task ids; duplicate titles keep distinct ids', () => {
    const note = store.addNote('identity probe');
    const item = convertToVerbItem(store, proposal(note.id));
    const originalIds = item.tasks.map((task) => task.id);
    // no-op re-groom (title-only, same multiset)
    const noop = updateGroom(store, item.id, proposal(item.id));
    expect(noop.tasks.map((task) => task.id)).toEqual(originalIds);
    // reorder
    const reorderedTitles = [...noop.tasks.map((task) => task.title)].reverse();
    const reordered = updateGroom(store, item.id, { ...proposal(item.id), tasks: reorderedTitles });
    expect(reordered.tasks.map((task) => task.id)).toEqual([...originalIds].reverse());
    // duplicate titles: two tasks named identically stay distinct rows
    updateGroom(store, item.id, {
      ...proposal(item.id),
      taskOps: [
        { op: 'keep', id: originalIds[0]! },
        { op: 'rename', id: originalIds[1]!, title: 'same name' },
        { op: 'add', title: 'same name' },
      ],
      tasks: ['same name', 'same name', 'same name'],
    });
    const after = store.getVerbItem(item.id);
    expect(after.tasks.filter((task) => task.title === 'same name').map((task) => task.id)).toEqual([
      originalIds[1],
      expect.any(String),
    ]);
  });

  test('title-only task changes refuse as ambiguous; taskOps preserve identity', () => {
    const note = store.addNote('ambiguity probe');
    const item = convertToVerbItem(store, proposal(note.id));
    const ids = item.tasks.map((task) => task.id);
    expect(() =>
      updateGroom(store, item.id, { ...proposal(item.id), tasks: ['investigate', 'fixed differently', 'test'] }),
    ).toThrow(/identity cannot be guessed/);
    const renamed = updateGroom(store, item.id, {
      ...proposal(item.id),
      taskOps: [
        { op: 'keep', id: ids[0]! },
        { op: 'rename', id: ids[1]!, title: 'fixed differently' },
      ],
      tasks: ['investigate', 'fixed differently'],
    });
    expect(renamed.tasks[1]!.id).toBe(ids[1]); // the renamed task keeps ONLY its declared id
  });

  test('stale-writer re-groom refuses without writing', () => {
    const note = store.addNote('stale groom probe');
    const item = convertToVerbItem(store, proposal(note.id));
    const revision = currentScopeRevision(store.db, item.id);
    expect(() =>
      updateGroom(store, item.id, { ...proposal(item.id), expectedRevision: revision + 5 }),
    ).toThrow(StaleWriterError);
    expect(currentScopeRevision(store.db, item.id)).toBe(revision);
  });

  test('scope revision: checkbox progress keeps scope identity; scope edits version it', () => {
    const note = store.addNote('scope divergence probe');
    const item = convertToVerbItem(store, proposal(note.id));
    const revisionBefore = currentScopeRevision(store.db, item.id);
    const checksumBefore = recordSpecVersion(store, item.id, renderCardSpec(store, store.getVerbItem(item.id))).checksum;
    // checkbox progress only — the render changes, scope identity does not
    store.syncTasks(
      item.id,
      store.getVerbItem(item.id).tasks.map((task, index) => ({ ...task, done: index === 0 })),
      'engine',
    );
    const checksumAfter = recordSpecVersion(store, item.id, renderCardSpec(store, store.getVerbItem(item.id))).checksum;
    expect(checksumAfter).not.toBe(checksumBefore); // publication identity moved
    expect(currentScopeRevision(store.db, item.id)).toBe(revisionBefore); // scope identity did not
    // a real scope edit versions the scope
    const ids = item.tasks.map((task) => task.id);
    updateGroom(store, item.id, {
      ...proposal(item.id),
      taskOps: [...ids.map((id) => ({ op: 'keep' as const, id })), { op: 'add' as const, title: 'brand new scope' }],
      tasks: ['investigate', 'fix', 'test', 'brand new scope'],
    });
    expect(currentScopeRevision(store.db, item.id)).toBe(revisionBefore + 1);
    // criterion lineage: the accepted delta requirement carries a stable id
    const criteria = scopeCriteria(store.db, item.id);
    expect(criteria).toHaveLength(1);
    expect(criteria[0]!.id).toMatch(/^c-[0-9a-f]{8}$/);
    expect(criteria[0]!.title).toBe('req');
  });

  test('legacy card: task ids retained, criterion identity unclassified until reviewed', async () => {
    // Simulate a legacy card: scope_revision NULL, no scope_items rows.
    const note = store.addNote('legacy identity probe');
    const item = convertToVerbItem(store, proposal(note.id));
    store.raw().exec(`UPDATE cards SET scope_revision = NULL WHERE id = '${item.id}'`);
    store.raw().exec(`DELETE FROM scope_items WHERE card_id = '${item.id}'`);
    store.raw().exec(`DELETE FROM scope_revisions WHERE card_id = '${item.id}'`);
    // a title-only no-op re-groom does NOT invent identity: the revision
    // ledger initializes (first write), but criteria stay unclassified and a
    // repeat no-op does not version again
    updateGroom(store, item.id, proposal(item.id));
    expect(scopeCriteria(store.db, item.id)).toEqual([]);
    const initialized = currentScopeRevision(store.db, item.id);
    updateGroom(store, item.id, proposal(item.id));
    expect(currentScopeRevision(store.db, item.id)).toBe(initialized); // identical scope: no new revision
    // a reviewed (identity-bearing) edit classifies explicitly
    updateGroom(store, item.id, {
      ...proposal(item.id),
      taskOps: store.getVerbItem(item.id).tasks.map((task) => ({ op: 'keep' as const, id: task.id })),
      tasks: item.tasks.map((task) => task.title),
    });
    expect(scopeCriteria(store.db, item.id)).toHaveLength(1); // classified, not invented
  });
});

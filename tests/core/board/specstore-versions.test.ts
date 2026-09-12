import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { updateGroom } from '../../../src/core/board/crud.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { specs } from '../../../src/core/board/specstore.ts';
import { tmpProject } from '../../helpers.ts';

// Task 2.4 — version law: groom accept records v1, re-edit appends,
// identical checksum does not duplicate.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-spec-versions-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

function proposal(noteId: string, title = 'refined: fix the thing') {
  return {
    noteId,
    proposedVerb: 'fix' as const,
    refinedTitle: title,
    research: { codebaseFindings: ['evidence'], sections: { reproduce: 'steps', rca: 'cause' } },
    specDeltas: [{ op: 'ADDED' as const, requirement: 'req', text: 'text' }],
    tasks: ['investigate'],
    openQuestions: [],
  };
}

describe('spec versions', () => {
  test('groom accept records version 1', () => {
    const note = store.addNote('fix the thing');
    convertToVerbItem(store, proposal(note.id));
    const versions = specs(store, note.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.markdown).toContain('# fix: refined: fix the thing');
    expect(versions[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test('re-edit appends a version', () => {
    const note = store.addNote('versioned change');
    convertToVerbItem(store, proposal(note.id));
    updateGroom(store, note.id, proposal(note.id, 'refined: now different'));
    const versions = specs(store, note.id);
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
  });

  test('identical content does not duplicate', () => {
    const note = store.addNote('stable change');
    const item = convertToVerbItem(store, proposal(note.id));
    updateGroom(store, note.id, proposal(note.id, item.title));
    const versions = specs(store, note.id);
    expect(versions).toHaveLength(1);
  });

  test('versions list newest-first', () => {
    const note = store.addNote('ordering check');
    convertToVerbItem(store, proposal(note.id));
    updateGroom(store, note.id, proposal(note.id, 'refined: second'));
    updateGroom(store, note.id, proposal(note.id, 'refined: third'));
    const versions = specs(store, note.id);
    expect(versions.map((version) => version.version)).toEqual([3, 2, 1]);
  });
});

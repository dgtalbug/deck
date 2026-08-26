import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NotFoundError } from '../../../src/core/board/errors.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { moveLane } from '../../../src/core/board/lanes.ts';
import { nextDigest } from '../../../src/core/board/next.ts';
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

describe('nextDigest', () => {
  test('returns the top groomed card with a ≤2k-token context', () => {
    const note = store.addNote('digest me');
    const item = convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'digest me',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['one', 'two'],
      openQuestions: [],
    });
    const digest = nextDigest(store);
    expect(digest.cardId).toBe(item.id);
    expect(digest.verb).toBe('feat');
    expect(digest.wipBlockedBy).toBeUndefined();
    expect(digest.context.length).toBeLessThanOrEqual(8000);
    expect(digest.context).toContain('digest me');
    expect(digest.context).toContain('- [ ] one');
  });

  test('empty queue throws NotFound', () => {
    const fresh = tmpProject();
    void (async () => {
      const other = await openStore(fresh.path);
      expect(() => nextDigest(other)).toThrow(NotFoundError);
      fresh.cleanup();
    })();
  });

  test('at WIP limit, names the most-advanced active card via wipBlockedBy', async () => {
    const fresh = tmpProject();
    try {
      const other = await openStore(fresh.path);
      for (const title of ['a', 'b', 'c']) {
        const note = other.addNote(title);
        const item = convertToVerbItem(other, {
          noteId: note.id,
          proposedVerb: 'feat',
          refinedTitle: title,
          research: { codebaseFindings: [] },
          specDeltas: [],
          tasks: ['only task'],
          openQuestions: [],
        });
        moveLane(other, item.id, 'active', 'engine');
      }
      const queued = convertToVerbItem(other, {
        noteId: other.addNote('queued').id,
        proposedVerb: 'fix',
        refinedTitle: 'queued',
        research: { codebaseFindings: [] },
        specDeltas: [],
        tasks: [],
        openQuestions: [],
      });
      const digest = nextDigest(other);
      expect(digest.wipBlockedBy).toBeDefined();
      expect(digest.cardId).not.toBe(queued.id);
      expect(digest.context).toContain('finish first');
    } finally {
      fresh.cleanup();
    }
  });
});

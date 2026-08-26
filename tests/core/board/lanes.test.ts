import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { LaneViolation, NotFoundError, WipLimitError } from '../../../src/core/board/errors.ts';
import { convertToVerbItem, tweak } from '../../../src/core/board/groom.ts';
import { assertTransition, moveLane, topOfQueue } from '../../../src/core/board/lanes.ts';
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

function groomedItem(title: string) {
  const note = store.addNote(title);
  return convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['task one'],
    openQuestions: [],
  });
}

describe('assertTransition', () => {
  test('allows manual todo↔groomed and rejects engine-only lanes for humans', () => {
    expect(() => assertTransition('c1', 'todo', 'groomed', 'human')).not.toThrow();
    expect(() => assertTransition('c1', 'groomed', 'todo', 'human')).not.toThrow();
    expect(() => assertTransition('c1', 'groomed', 'active', 'human')).toThrow(LaneViolation);
    expect(() => assertTransition('c1', 'active', 'verify', 'human')).toThrow(LaneViolation);
    expect(() => assertTransition('c1', 'groomed', 'active', 'engine')).not.toThrow();
    expect(() => assertTransition('c1', 'verify', 'done', 'engine')).not.toThrow();
  });
});

describe('moveLane', () => {
  test('human move groomed→todo succeeds; human move into active throws', () => {
    const item = groomedItem('movable card');
    const moved = moveLane(store, item.id, 'todo');
    expect(moved.lane).toBe('todo');

    const item2 = groomedItem('engine owned');
    expect(() => moveLane(store, item2.id, 'active')).toThrow(LaneViolation);
    expect(store.getVerbItem(item2.id).lane).toBe('groomed');
  });

  test('engine move into active succeeds', () => {
    const item = groomedItem('engine builds this');
    const moved = moveLane(store, item.id, 'active', 'engine');
    expect(moved.lane).toBe('active');
  });

  test('unknown card throws NotFound', () => {
    expect(() => moveLane(store, 'ghost-card', 'todo')).toThrow(NotFoundError);
  });
});

describe('WIP limit', () => {
  test('tweak and engine move refuse beyond the limit (default 3)', async () => {
    const fresh = tmpProject();
    try {
      const other = await openStore(fresh.path);
      const makeGroomed = (title: string) => {
        const note = other.addNote(title);
        return convertToVerbItem(other, {
          noteId: note.id,
          proposedVerb: 'feat',
          refinedTitle: title,
          research: { codebaseFindings: [] },
          specDeltas: [],
          tasks: ['only task'],
          openQuestions: [],
        });
      };
      moveLane(other, makeGroomed('wip a').id, 'active', 'engine');
      moveLane(other, makeGroomed('wip b').id, 'active', 'engine');
      moveLane(other, makeGroomed('wip c').id, 'active', 'engine');

      const note = other.addNote('fourth card');
      expect(() => tweak(other, note.id)).toThrow(WipLimitError);

      const fifth = makeGroomed('wip e');
      expect(() => moveLane(other, fifth.id, 'active', 'engine')).toThrow(WipLimitError);
    } finally {
      fresh.cleanup();
    }
  });
});

describe('topOfQueue', () => {
  test('returns the first non-blocked groomed card', async () => {
    const fresh = tmpProject();
    try {
      const other = await openStore(fresh.path);
      const first = convertToVerbItem(other, {
        noteId: other.addNote('top card').id,
        proposedVerb: 'fix',
        refinedTitle: 'top card',
        research: { codebaseFindings: [] },
        specDeltas: [],
        tasks: [],
        openQuestions: [],
      });
      convertToVerbItem(other, {
        noteId: other.addNote('second card').id,
        proposedVerb: 'fix',
        refinedTitle: 'second card',
        research: { codebaseFindings: [] },
        specDeltas: [],
        tasks: [],
        openQuestions: [],
      });
      expect(topOfQueue(other)?.id).toBe(first.id);
      other.setBlocked(first.id, 'waiting');
      expect(topOfQueue(other)?.id).not.toBe(first.id);
    } finally {
      fresh.cleanup();
    }
  });
});

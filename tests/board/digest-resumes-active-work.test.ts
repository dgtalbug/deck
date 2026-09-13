// digest-resumes-active (deck-next-breaks fix, E02 resume-first): the
// nextDigest contract — the most-advanced active card leads, including when
// WIP has spare capacity; the empty board is a friendly non-mutating result.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { nextDigest } from '../../src/core/board/next.ts';
import type { GroomProposal } from '../../src/core/board/types.ts';

function proposal(noteId: string, title = 'digest resume probe'): GroomProposal {
  return {
    noteId,
    proposedVerb: 'chore',
    refinedTitle: title,
    research: {
      codebaseFindings: [],
      sections: { reproduce: 'r', rca: 'c' },
    },
    specDeltas: [],
    tasks: ['one task'],
    openQuestions: [],
  };
}

describe('nextDigest resumes active work', () => {
  const dirs: string[] = [];
  async function fresh() {
    const dir = mkdtempSync(join(tmpdir(), 'digest-resumes-'));
    dirs.push(dir);
    return openStore(dir);
  }

  test('active card + empty groomed queue returns the build pack, not a 404', async () => {
    const store = await fresh();
    const item = convertToVerbItem(store, proposal(store.addNote('in flight').id, 'in flight card'));
    moveLane(store, item.id, 'active', 'engine');
    const digest = nextDigest(store); // previously: NotFoundError top-of-queue
    expect(digest.cardId).toBe(item.id);
    expect(digest.context).toContain('in flight card');
    expect(digest.context).toContain('branch:');
  });

  test('active card + non-empty groomed queue resumes the active card first', async () => {
    const store = await fresh();
    const active = convertToVerbItem(store, proposal(store.addNote('busy').id));
    moveLane(store, active.id, 'active', 'engine');
    const queued = convertToVerbItem(store, proposal(store.addNote('next up').id));
    const digest = nextDigest(store);
    expect(digest.cardId).toBe(active.id); // resume-first, even with spare WIP
    expect(digest.context).toContain('resume this card first');
    // read-only: both lanes untouched
    expect(store.getVerbItem(queued.id).lane).toBe('groomed');
    expect(store.getVerbItem(active.id).lane).toBe('active');
  });

  test('empty board is a friendly no-work result, board untouched', async () => {
    const store = await fresh();
    const digest = nextDigest(store);
    expect(digest.empty).toBe(true);
    expect(digest.context).toContain('no work');
    expect(store.listCards('todo')).toHaveLength(0);
  });

  test('cleanup', () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
});

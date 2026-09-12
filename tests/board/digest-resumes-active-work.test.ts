// digest-resumes-active (deck-next-breaks fix): the nextDigest contract —
// WHEN any active card exists and the groomed queue is empty, the digest is
// that card's build pack, never a lookup failure, regardless of WIP limit.
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

  test('active card + non-empty groomed queue still prefers the queue top', async () => {
    const store = await fresh();
    const active = convertToVerbItem(store, proposal(store.addNote('busy').id));
    moveLane(store, active.id, 'active', 'engine');
    const queued = convertToVerbItem(store, proposal(store.addNote('next up').id));
    expect(nextDigest(store).cardId).toBe(queued.id);
  });

  test('empty board still refuses with the typed not-found', async () => {
    const store = await fresh();
    expect(() => nextDigest(store)).toThrow(/top-of-queue/);
  });

  test('cleanup', () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
});

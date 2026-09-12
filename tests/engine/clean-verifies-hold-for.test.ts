// clean-verifies-hold-for (verify-clean-on-ziyi fix): a clean verify result
// HOLDS the card in verify — done is archive's merge door alone. The old
// clean→done jump skipped the PR and stranded the card (archive and review
// both refuse done).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { runVerification } from '../../src/core/engine/verify.ts';
import { ensureVerifyLane } from '../../src/core/engine/verify.ts';
import { applyVerifyResult } from '../../src/core/board/verify.ts';
import type { GroomProposal } from '../../src/core/board/types.ts';

function proposal(noteId: string): GroomProposal {
  return {
    noteId,
    proposedVerb: 'chore',
    refinedTitle: 'clean hold probe',
    research: { codebaseFindings: [], sections: { reproduce: 'r', rca: 'c' } },
    specDeltas: [],
    tasks: [],
    openQuestions: [],
  };
}

describe('clean verifies hold for archive', () => {
  const dirs: string[] = [];
  async function fresh() {
    const dir = mkdtempSync(join(tmpdir(), 'clean-hold-'));
    dirs.push(dir);
    return openStore(dir);
  }

  test('computed clean on an active card holds in verify, not done', async () => {
    const store = await fresh();
    const item = convertToVerbItem(store, proposal(store.addNote('hold').id));
    moveLane(store, item.id, 'active', 'engine');
    const outcome = await runVerification(store, item.id);
    expect(outcome.result).toBe('clean');
    expect(store.getVerbItem(item.id).lane).toBe('verify'); // previously: done
  });

  test('re-running computed clean on a verify card stays in verify', async () => {
    const store = await fresh();
    const item = convertToVerbItem(store, proposal(store.addNote('recheck').id));
    ensureVerifyLane(store, item.id);
    moveLane(store, item.id, 'verify', 'engine');
    await runVerification(store, item.id);
    expect(store.getVerbItem(item.id).lane).toBe('verify');
  });

  test('done is still reachable — archive path (applyVerifyResult clean on verify)', async () => {
    const store = await fresh();
    const item = convertToVerbItem(store, proposal(store.addNote('closes').id));
    moveLane(store, item.id, 'verify', 'engine');
    const card = applyVerifyResult(store, item.id, 'clean');
    expect('lane' in card && card.lane).toBe('done'); // archive's internal door, unchanged
  });

  test('cleanup', () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
});

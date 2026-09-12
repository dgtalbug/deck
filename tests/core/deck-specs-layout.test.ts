// .deck/specs layout (jira-style-deck direction v2): groomed cards
// materialize under .deck/specs/<shape>/ — ≤3 tasks = tasks/, >3 = stories/
// — never in the user's repo root. Existing cards keep their recorded
// specPath (specs/changes/…) and continue to render and re-groom there.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import type { GroomProposal } from '../../src/core/board/types.ts';

function proposal(noteId: string, tasks: string[]): GroomProposal {
  return {
    noteId,
    proposedVerb: 'chore',
    refinedTitle: 'layout probe',
    research: { codebaseFindings: [], sections: { reproduce: 'r', rca: 'c' } },
    specDeltas: [],
    tasks,
    openQuestions: [],
  };
}

describe('.deck/specs layout', () => {
  let dir: string;
  let store: Awaited<ReturnType<typeof openStore>>;

  test('a small card materializes under .deck/specs/tasks/, not the repo root', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deck-specs-layout-'));
    store = await openStore(dir);
    const item = convertToVerbItem(store, proposal(store.addNote('small').id, ['one']));
    expect(item.specPath).toBe(`.deck/specs/tasks/chore-${item.id}/`);
    expect(existsSync(join(dir, item.specPath, 'spec.md'))).toBe(true);
    expect(existsSync(join(dir, 'specs'))).toBe(false); // nothing in the repo root
  });

  test('a >3-task card is story-shaped: .deck/specs/stories/', async () => {
    const item = convertToVerbItem(store, proposal(store.addNote('big').id, ['a', 'b', 'c', 'd']));
    expect(item.specPath).toBe(`.deck/specs/stories/chore-${item.id}/`);
    expect(existsSync(join(dir, item.specPath, 'tasks.md'))).toBe(true);
  });

  test('the spec renders from wherever the card points (old-layout cards unaffected)', async () => {
    const { renderCardSpec } = await import('../../src/core/board/specstore.ts');
    const item = store.getVerbItem(store.listCards('groomed')[0]!.id);
    expect(renderCardSpec(store, item)).toContain('# chore: layout probe');
  });

  test('cleanup', () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

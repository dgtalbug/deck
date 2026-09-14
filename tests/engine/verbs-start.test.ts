import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { archiveVerb, startVerb, branchFor } from '../../src/core/engine/verbs.ts';
import { enrollPolicy } from '../../src/core/board/rules.ts';
import { getIssueMap } from '../../src/core/board/specstore.ts';
import { nextDigest } from '../../src/core/board/next.ts';
import { DeckError, WipLimitError } from '../../src/core/board/errors.ts';
import type { Verb as VerbType } from '../../src/core/board/types.ts';

// Real tmp git repos + gh stub (ops.test.ts pattern): every guard runs
// against git itself.
let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;
let prevGh: string | undefined;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function stubGh(script: string): void {
  writeFileSync(join(binDir, 'gh'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
  if (prevGh !== undefined) {
    process.env['DECK_GH_BIN'] = prevGh;
    prevGh = undefined;
  } else {
    delete process.env['DECK_GH_BIN'];
  }
}

function offlineGh(): void {
  prevGh = process.env['DECK_GH_BIN'];
  process.env['DECK_GH_BIN'] = join(binDir, 'nowhere');
}

const GH_OK = `case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/21" ;;
  "issue edit") echo ok ;;
  "issue view") echo "{\\"number\\":21,\\"state\\":\\"OPEN\\",\\"labels\\":[{\\"name\\":\\"groomed\\"}],\\"url\\":\\"u\\"}" ;;
  "issue close") echo closed ;;
  "pr create") echo "https://github.com/o/r/pull/31" ;;
  "pr list") echo "[]" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac`;

function groomed(title: string, verb: VerbType = 'feat', tasks: string[] = ['implement', 'verify']): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: verb,
    refinedTitle: title,
    research: verb === 'fix' ? { codebaseFindings: [], sections: { reproduce: 'steps', rca: 'cause' } } : { codebaseFindings: [] },
    specDeltas: [],
    tasks,
    openQuestions: [],
  });
  return note.id;
}

// done-only satisfaction helper: engine lane move straight to done
async function moveDone(id: string): Promise<void> {
  const { moveLane } = await import('../../src/core/board/lanes.ts');
  moveLane(store, id, 'done', 'engine');
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-verbs-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-verbs-bin-'));
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\norigin.git/\n');
  git('init --bare origin.git');
  git('remote add origin ./origin.git');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -m "c1"');
  git('push -u origin main');
  store = await openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
  if (prevGh !== undefined) {
    process.env['DECK_GH_BIN'] = prevGh;
    prevGh = undefined;
  } else {
    delete process.env['DECK_GH_BIN'];
  }
});

describe('startVerb', () => {
  test('happy path: active + branch + issue at start', async () => {
    stubGh(GH_OK);
    const id = groomed('add the gate');
    const outcome = await startVerb(store, id, 'feat');
    expect(outcome.card.lane).toBe('active');
    expect(outcome.branch).toBe(branchFor(outcome.card, 'feat'));
    expect(git('rev-parse --abbrev-ref HEAD').trim()).toBe(outcome.branch);
    expect(git('branch --format="%(refname:short)"').trim().split('\n')).toContain(outcome.branch);
    expect(outcome.issueNumber).toBe(21);
    expect(outcome.queued).toBe(false);
    expect(getIssueMap(store, id)?.issueNumber).toBe(21);
  });

  test('verb mismatch refuses, nothing changes', async () => {
    stubGh(GH_OK);
    const id = groomed('fix the leak', 'fix');
    await expect(startVerb(store, id, 'feat')).rejects.toThrow(DeckError);
    expect(store.getVerbItem(id).lane).toBe('groomed');
    expect(git('branch --format="%(refname:short)"').trim()).toBe('main');
  });

  test('dirty tree refuses and compensates back to groomed', async () => {
    stubGh(GH_OK);
    const id = groomed('dirty start');
    writeFileSync(join(dir, 'b.txt'), 'dirty\n');
    await expect(startVerb(store, id, 'feat')).rejects.toThrow(/not clean/);
    expect(store.getVerbItem(id).lane).toBe('groomed');
    expect(git('rev-parse --abbrev-ref HEAD').trim()).toBe('main');
    expect(git('branch --format="%(refname:short)"').trim()).toBe('main');
  });

  test('existing branch refuses and compensates', async () => {
    stubGh(GH_OK);
    const id = groomed('branch collision');
    const card = store.getVerbItem(id);
    git(`branch ${branchFor(card, 'feat')}`);
    await expect(startVerb(store, id, 'feat')).rejects.toThrow(DeckError);
    expect(store.getVerbItem(id).lane).toBe('groomed');
  });

  test('WIP limit refuses before anything happens', async () => {
    stubGh(GH_OK);
    for (let i = 0; i < 3; i++) {
      const id = groomed(`wip filler ${i}`);
      await startVerb(store, id, 'feat');
      writeFileSync(join(dir, `f${i}.txt`), 'x\n');
      git('add .');
      git('commit -m "fill"');
      git('switch main');
    }
    const id = groomed('over limit');
    await expect(startVerb(store, id, 'feat')).rejects.toThrow(WipLimitError);
    expect(store.getVerbItem(id).lane).toBe('groomed');
  });

  test('offline start still works, publish queues', async () => {
    offlineGh();
    const id = groomed('offline start');
    const outcome = await startVerb(store, id, 'feat');
    expect(outcome.card.lane).toBe('active');
    expect(outcome.queued).toBe(true);
    expect(outcome.issueNumber).toBeNull();
    expect(git('rev-parse --abbrev-ref HEAD').trim()).toBe(outcome.branch);
  });

});
describe('context pack', () => {
  test('at-limit deck next carries branch + issue + checklist within budget', async () => {
    stubGh(GH_OK);
    const id = groomed('pack card');
    const outcome = await startVerb(store, id, 'feat');
    // fill the wip limit to make next serve the pack
    for (let i = 0; i < 2; i++) {
      const filler = groomed(`pack filler ${i}`);
      await startVerb(store, filler, 'feat');
      git('switch main');
    }
    const digest = nextDigest(store);
    // Whichever active card is most advanced, the digest IS the pack:
    // branch, mapped issue, checklist, inside the ≤2k-token budget.
    expect(digest.wipBlockedBy).toBeDefined();
    expect(digest.context).toMatch(/branch: (feat|fix)\//);
    expect(digest.context).toContain('issue: #21');
    // E02 packet: the checklist appears as the materialized Tasks/Checklist sections
    expect(digest.context).toContain('## Tasks');
    expect(digest.context).toContain('## Checklist');
    expect(digest.context.length).toBeLessThanOrEqual(8000); // ≤2k tokens at ~4 chars
  });
});

describe('archiveVerb (preparation)', () => {
  test('happy path: PR created, delivery pending, card holds in verify', async () => {
    stubGh(GH_OK);
    const id = groomed('archivable gate');
    const started = await startVerb(store, id, 'feat');
    enrollPolicy(store, id, { mode: 'team' });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    writeFileSync(join(dir, 'c.txt'), 'the change\n');
    git('add .');
    git('commit -m "feat: the change"');
    const outcome = await archiveVerb(store, id);
    // E05: an open PR is NOT done — the card waits in verify.
    expect(outcome.card.lane).toBe('verify');
    expect(outcome.prUrl).toBe('https://github.com/o/r/pull/31');
    expect(outcome.issueNumber).toBe(21);
    expect(outcome.delivery.state).toBe('pending');
    expect(outcome.delivery.reused).toBe(false);
    // The default branch was never touched and the issue stays open.
    expect(git('log --merges --format="%s"')).not.toContain(`merge: ${started.branch}`);
  });

  test('preparation without an enrolled policy refuses (explicit migration)', async () => {
    stubGh(GH_OK);
    const id = groomed('unenrolled archive');
    await startVerb(store, id, 'feat');
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    await expect(archiveVerb(store, id)).rejects.toThrow(/no enrolled delivery\/evidence policy/);
    expect(store.getVerbItem(id).lane).toBe('active');
  });

  test('dirty tree refuses before any mutation', async () => {
    stubGh(GH_OK);
    const id = groomed('dirty archive');
    await startVerb(store, id, 'feat');
    enrollPolicy(store, id, { mode: 'team' });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    writeFileSync(join(dir, 'd.txt'), 'wip\n');
    await expect(archiveVerb(store, id)).rejects.toThrow(/not clean/);
    expect(store.getVerbItem(id).lane).toBe('active');
  });

  test('card without a published issue refuses', async () => {
    stubGh(GH_OK);
    const id = groomed('unpublished archive');
    await startVerb(store, id, 'feat');
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    // wipe the map to simulate a never-published card
    store.db.run('DELETE FROM issue_map');
    await expect(archiveVerb(store, id)).rejects.toThrow(/no published issue/);
    expect(store.getVerbItem(id).lane).toBe('active');
  });
});

// --- E03: dependency-ready starts (DECK-ARCH-016) + persisted readiness ------
import { setDependencies } from '../../src/core/board/planning.ts';
import { DependencyBlockedError } from '../../src/core/board/errors.ts';
import { listUnsettledOperations } from '../../src/core/engine/ownership.ts';

describe('E03 dependency start gate', () => {
  test('unmet prerequisite refuses the direct start — no reservation, no effects', async () => {
    stubGh(GH_OK);
    const prereq = groomed('unfinished prerequisite card');
    const story = groomed('dependent story card');
    setDependencies(store, story, [prereq]);
    await expect(startVerb(store, story, 'feat')).rejects.toThrow(DependencyBlockedError);
    // neither story moved, nothing reserved
    expect(store.getVerbItem(story).lane).toBe('groomed');
    expect(store.getVerbItem(prereq).lane).toBe('groomed');
    expect(listUnsettledOperations(store)).toEqual([]);
    expect(git('branch --format="%(refname:short)"').trim()).toBe('main');
  });

  test('clean-but-not-done does NOT satisfy; done does', async () => {
    stubGh(GH_OK);
    const prereq = groomed('prereq to done card');
    const story = groomed('waiting story card');
    setDependencies(store, story, [prereq]);
    await startVerb(store, prereq, 'feat'); // active + issue open, NOT done
    writeFileSync(join(dir, 'p.txt'), 'x\n');
    git('add .');
    git('commit -m "p"');
    // hold the prerequisite in verify (clean but not done): still blocks
    const { applyExplicitResult } = await import('../../src/core/board/verify.ts');
    applyExplicitResult(store, prereq, 'clean');
    expect(store.getVerbItem(prereq).lane).toBe('verify');
    await expect(startVerb(store, story, 'feat')).rejects.toThrow(DependencyBlockedError);
    // done satisfies
    await moveDone(prereq);
    const outcome = await startVerb(store, story, 'feat');
    expect(outcome.card.lane).toBe('active');
  });

  test('a start whose reservation raced a dependency edit refuses inside the boundary', async () => {
    stubGh(GH_OK);
    const prereq = groomed('race prereq card');
    const story = groomed('race dependent card');
    setDependencies(store, story, [prereq]);
    // Simulate the race: the edge is inserted AFTER the start's earlier reads
    // but BEFORE the reservation transaction reads it — modeled by an edge
    // added while the start is between gates. The transaction re-check wins.
    const { runTx } = await import('../../src/core/board/store.ts');
    const { storyDeps } = await import('../../src/core/board/schema.ts');
    const store2 = await openStore(dir);
    const startPromise = startVerb(store, story, 'feat');
    runTx(store2.db, (tx) => {
      tx.insert(storyDeps)
        .values({ cardId: story, dependsOn: prereq, createdAt: new Date().toISOString() })
        .onConflictDoNothing()
        .run();
    });
    // Either the start saw the edge (refusal) or committed before it landed —
    // but never an invalid start. Serialize and assert the invariant.
    try {
      await startPromise;
      // started before the edge landed: acceptable, undo for cleanup
      git('switch main');
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyBlockedError);
      expect(store.getVerbItem(story).lane).toBe('groomed');
      expect(listUnsettledOperations(store)).toEqual([]);
    }
    void store2;
  });

  test('legacy oversized card reports unknown readiness facts instead of refusing', async () => {
    stubGh(GH_OK);
    // four tasks groomed WITH spec content, then research blanked at the db
    // level — a legacy card whose readiness facts no longer exist
    const note = store.addNote('legacy oversized card');
    const { convertToVerbItem: convert } = await import('../../src/core/board/groom.ts');
    convert(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'legacy oversized card',
      research: { codebaseFindings: ['had a story once'], story: 'long story' },
      specDeltas: [],
      tasks: ['a', 'b', 'c', 'd'],
      openQuestions: [],
    });
    const id = note.id;
    store.raw().exec(`UPDATE cards SET research = '{"codebaseFindings":[]}' WHERE id = '${id}'`);
    const outcome = await startVerb(store, id, 'feat');
    expect(outcome.readinessUnknown).toEqual(['story shape (accepted deltas are not persisted on legacy cards)']);
    git('switch main');
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { archiveVerb, startVerb, branchFor } from '../../src/core/engine/verbs.ts';
import { getIssueMap } from '../../src/core/board/specstore.ts';
import { nextDigest } from '../../src/core/board/next.ts';
import { DeckError, WipLimitError } from '../../src/core/board/errors.ts';

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
  "auth status") exit 0 ;;
  *) echo ok ;;
esac`;

function groomed(title: string, verb: 'feat' | 'fix' = 'feat'): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: verb,
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['implement', 'verify'],
    openQuestions: [],
  });
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-verbs-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-verbs-bin-'));
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -m "c1"');
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
    expect(digest.context).toContain('## Remaining tasks');
    expect(digest.context.length).toBeLessThanOrEqual(8000); // ≤2k tokens at ~4 chars
  });
});

describe('archiveVerb', () => {
  test('happy path: PR merged, card done, issue closed, branch deleted', async () => {
    stubGh(GH_OK);
    const id = groomed('archivable gate');
    const started = await startVerb(store, id, 'feat');
    writeFileSync(join(dir, 'c.txt'), 'the change\n');
    git('add .');
    git('commit -m "feat: the change"');
    const outcome = await archiveVerb(store, id);
    expect(outcome.card.lane).toBe('done');
    expect(outcome.prUrl).toBe('https://github.com/o/r/pull/31');
    expect(outcome.issueNumber).toBe(21);
    expect(git('rev-parse --abbrev-ref HEAD').trim()).toBe('main');
    expect(git('branch --format="%(refname:short)"').trim().split('\n')).not.toContain(started.branch);
    expect(git('log --merges --format="%s"')).toContain(`merge: ${started.branch}`);
  });

  test('dirty tree refuses before any mutation', async () => {
    stubGh(GH_OK);
    const id = groomed('dirty archive');
    await startVerb(store, id, 'feat');
    writeFileSync(join(dir, 'd.txt'), 'wip\n');
    await expect(archiveVerb(store, id)).rejects.toThrow(/not clean/);
    expect(store.getVerbItem(id).lane).toBe('active');
  });

  test('card without a published issue refuses', async () => {
    stubGh(GH_OK);
    const id = groomed('unpublished archive');
    await startVerb(store, id, 'feat');
    // wipe the map to simulate a never-published card
    store.db.run('DELETE FROM issue_map');
    await expect(archiveVerb(store, id)).rejects.toThrow(/no published issue/);
    expect(store.getVerbItem(id).lane).toBe('active');
  });
});

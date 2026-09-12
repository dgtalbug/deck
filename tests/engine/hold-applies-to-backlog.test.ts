import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { HoldViolation } from '../../src/core/board/errors.ts';

// The paired file for the "Hold Applies To Backlog Lanes Only" requirement:
// hold means pick-later (todo → groom later, groomed → build later); every
// other lane refuses with a typed error, and legacy flags sweep at open.
let dir: string;
let store: DocumentStore;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function seedCard(title: string): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['one task'],
    openQuestions: [],
  });
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-hold-'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), '.deck/\nspecs/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m c1');
  store = await openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('setBlocked lane guard', () => {
  test('todo card can be held and unheld', () => {
    const id = seedCard('hold todo card');
    store.setBlocked(id, 'waiting on spec');
    expect(store.getVerbItem(id).blocked?.reason).toBe('waiting on spec');
    store.setBlocked(id);
    expect(store.getVerbItem(id).blocked).toBeUndefined();
  });

  test('groomed card can be held', () => {
    const id = seedCard('hold groomed card');
    store.setBlocked(id, 'pick later');
    expect(store.getVerbItem(id).blocked?.reason).toBe('pick later');
  });

  test('active card refuses hold with a typed HoldViolation', async () => {
    const id = seedCard('hold active card');
    moveLane(store, id, 'active', 'engine');
    expect(() => store.setBlocked(id, 'pause')).toThrow(HoldViolation);
    expect(store.getVerbItem(id).blocked).toBeUndefined();
  });

  test('done card refuses hold — done has the revert door, not hold', async () => {
    const id = seedCard('hold done card');
    moveLane(store, id, 'active', 'engine');
    moveLane(store, id, 'verify', 'engine');
    moveLane(store, id, 'done', 'engine');
    expect(() => store.setBlocked(id, 'pause')).toThrow(HoldViolation);
  });

  test('the refusal message explains the law and the door', async () => {
    const id = seedCard('hold verify card');
    moveLane(store, id, 'active', 'engine');
    moveLane(store, id, 'verify', 'engine');
    try {
      store.setBlocked(id, 'pause');
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('pick-later');
      expect(message).toContain('todo/groomed');
      expect(message).toContain('deck revert');
    }
  });

  test('unblock stays open on engine lanes so stale flags can clear by hand', async () => {
    const id = seedCard('unblock legacy card');
    moveLane(store, id, 'active', 'engine');
    // plant a legacy flag behind the guard (pre-law rows look like this)
    store.db
      .run(
        // biome-ignore lint/security/non-literal-sql: fixed literal in a test
        `UPDATE cards SET blocked_reason = 'legacy' WHERE id = '${id}'`,
      );
    store.setBlocked(id);
    expect(store.getVerbItem(id).blocked).toBeUndefined();
  });
});

describe('on-open sweep', () => {
  test('legacy blocked flags on engine-lane cards are cleared at open', async () => {
    const id = seedCard('sweep target card');
    moveLane(store, id, 'active', 'engine');
    store.db
      .run(
        // biome-ignore lint/security/non-literal-sql: fixed literal in a test
        `UPDATE cards SET blocked_reason = 'legacy', blocked_at = '2020-01-01T00:00:00Z' WHERE id = '${id}'`,
      );
    const reopened = await openStore(dir);
    expect(reopened.getVerbItem(id).blocked).toBeUndefined();
  });

  test('backlog flags survive the sweep', () => {
    const id = seedCard('keep my hold card');
    store.setBlocked(id, 'pick later');
    expect(store.getVerbItem(id).blocked?.reason).toBe('pick later');
  });
});

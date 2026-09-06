import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { startVerb } from '../../src/core/engine/verbs.ts';
import { ensureVerifyLane, runVerification } from '../../src/core/engine/verify.ts';
import { DeckError } from '../../src/core/board/errors.ts';

// verify-fix — the paired file for the "Verify reaches verify lane"
// requirement: `deck verify` runs on ACTIVE cards (engine moves them into
// verify first); refusals unchanged.
let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/21" ;;
  "issue view") echo "{"number":21,"state":"OPEN","labels":[],"url":"u"}" ;;
  "issue edit"|"issue close"|"pr create") echo ok ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function groomed(title: string, tasks: string[]): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks,
    openQuestions: [],
  });
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-verify-reach-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-verify-reach-bin-'));
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
});

describe('verify reaches verify lane', () => {
  test('ensureVerifyLane moves an active card into verify; others unchanged', async () => {
    stubGh();
    const id = groomed('reach probe', ['task one']);
    await startVerb(store, id, 'feat');
    expect(store.getVerbItem(id).lane).toBe('active');
    ensureVerifyLane(store, id);
    expect(store.getVerbItem(id).lane).toBe('verify');
    ensureVerifyLane(store, id); // idempotent on verify-lane cards
    expect(store.getVerbItem(id).lane).toBe('verify');
  });

  test('computed verify on an active card: gaps appends tasks and loops back to active', async () => {
    stubGh();
    const id = groomed('gaps probe', ['task one']);
    await startVerb(store, id, 'feat');
    const outcome = await runVerification(store, id);
    expect(outcome.result).toBe('gaps');
    expect(outcome.card.lane).toBe('active');
    expect(store.getVerbItem(id).tasks.map((task) => task.title)).toContain('task one');
  });

  test('computed verify on an active card with all tasks done finishes clean', async () => {
    stubGh();
    const id = groomed('clean probe', ['task one']);
    await startVerb(store, id, 'feat');
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    const outcome = await runVerification(store, id);
    expect(outcome.result).toBe('clean');
    expect(outcome.card.lane).toBe('done');
  });

  test('unknown and non-verb cards still refuse with the typed errors', () => {
    expect(() => ensureVerifyLane(store, 'ghost')).toThrow(DeckError);
    const note = store.addNote('just a note');
    expect(() => ensureVerifyLane(store, note.id)).toThrow(DeckError);
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveLane } from '../../src/core/board/lanes.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { runVerification } from '../../src/core/engine/verify.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import { nextDigest } from '../../src/core/board/next.ts';

// Task 2.2 — the converge loop: a seeded gap loops the card to active with
// the task appended (addedByVerify) and deck next surfaces it; re-verification
// after the fixes converges to done.
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
  "issue create") echo "https://github.com/o/r/issues/102" ;;
  "issue view") echo "{\\"number\\":102,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  "issue edit") echo ok ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

async function verifyCard(title: string, tasks: string[]): Promise<string> {
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
  await publishSpec(store, note.id);
  moveLane(store, note.id, 'active', 'engine');
  moveLane(store, note.id, 'verify', 'engine');
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-converge-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-converge-bin-'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m "c1"');
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

describe('runVerification', () => {
  test('seeded gap loops the card to active with the task appended', async () => {
    stubGh();
    const id = await verifyCard('converge seeded', ['the unfinished work']);
    const outcome = runVerification(store, id);
    expect(outcome.result).toBe('gaps');
    expect(outcome.gaps).toHaveLength(1);
    const card = store.getVerbItem(id);
    expect(card.lane).toBe('active');
    const appended = card.tasks.find((task) => task.title === 'the unfinished work' && task.addedByVerify === true);
    expect(appended).toBeDefined();
  });

  test('clean verification finishes to done', async () => {
    stubGh();
    const id = await verifyCard('converge clean', ['all done']);
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    const outcome = runVerification(store, id);
    expect(outcome.result).toBe('clean');
    expect(store.getVerbItem(id).lane).toBe('done');
  });

  test('the loop converges: gap → fix → clean', async () => {
    stubGh();
    const id = await verifyCard('converge loop', ['first pass']);
    runVerification(store, id); // gaps → active + appended
    const card = store.getVerbItem(id);
    expect(card.tasks).toHaveLength(2); // original + appended copy
    store.syncTasks(id, card.tasks.map((task) => ({ ...task, done: true })), 'engine');
    moveLane(store, id, 'verify', 'engine');
    const second = runVerification(store, id);
    expect(second.result).toBe('clean');
    expect(store.getVerbItem(id).lane).toBe('done');
  });
});

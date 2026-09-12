// add-engine-event-hooks — paired file for "Seven engine moments each fire
// pre and post": every moment's pre hook sees the pre-transition lane before
// the state changes, the post hook sees the post-transition lane after, and
// the legacy convention events still fire exactly once.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { startVerb, archiveVerb } from '../../src/core/engine/verbs.ts';
import { runVerification, reviewGate } from '../../src/core/engine/verify.ts';

let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;
let marker: string;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/9" ;;
  "issue edit") echo ok ;;
  "issue view") echo "{\\"number\\":9,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  "pr create") echo "https://github.com/o/r/pull/19" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

// One declared hook per moment per phase appends "<moment> <lane> <phase>"
// to the marker — the run log of the whole grid.
function writeRules(): void {
  const phases = ['pre', 'post']
    .map((phase) => MOMENT_LINES.map((line) => `  - on: ${line.moment}\n    ${phase}: 'echo "${line.moment} \$DECK_LANE ${phase}" >> ${marker}'`).join('\n'))
    .join('\n');
  writeFileSync(join(dir, 'deck.rules.yaml'), `version: 1\nhooks:\n${phases}\n`);
}

const MOMENT_LINES = [
  { moment: 'note' },
  { moment: 'groom' },
  { moment: 'feat' },
  { moment: 'task' },
  { moment: 'verify' },
  { moment: 'review' },
  { moment: 'archive' },
];

function markerLines(): string[] {
  return readFileSync(marker, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-moments-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-moments-bin-'));
  stubGh();
  marker = join(dir, '.deck', 'moments.txt');
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\norigin.git/\ndeck.rules.yaml\n');
  git('init --bare origin.git');
  git('remote add origin ./origin.git');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m c1');
  store = await openStore(dir);
  writeRules();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
});

describe('the seven moments fire pre and post', () => {
  test('note: pre before the insert, post after — lane todo both sides', () => {
    store.addNote('moment grid note');
    expect(markerLines()).toEqual(['note todo pre', 'note todo post']);
  });

  test('groom: pre sees the note (todo), post sees the groomed verb item', () => {
    const note = store.addNote('moment grid groom');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'moment grid groom',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['implement'],
      openQuestions: [],
    });
    const lines = markerLines().filter((line) => line.startsWith('groom '));
    expect(lines).toEqual(['groom todo pre', 'groom groomed post']);
  });

  test('task: pre before the rewrite, post after', async () => {
    const note = store.addNote('moment grid task');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'moment grid task',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['implement'],
      openQuestions: [],
    });
    store.syncTasks(note.id, store.getVerbItem(note.id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    const lines = markerLines().filter((line) => line.startsWith('task '));
    expect(lines).toEqual(['task groomed pre', 'task groomed post']);
  });

  test('feat: pre sees groomed before the transition, post sees active after', async () => {
    const note = store.addNote('moment grid feat');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'moment grid feat',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['implement'],
      openQuestions: [],
    });
    await startVerb(store, note.id, 'feat');
    const lines = markerLines().filter((line) => line.startsWith('feat '));
    expect(lines).toEqual(['feat groomed pre', 'feat active post']);
  });

  test('verify: pre sees active, post sees verify holding', async () => {
    const note = store.addNote('moment grid verify');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'moment grid verify',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: [],
      openQuestions: [],
    });
    await startVerb(store, note.id, 'feat');
    const outcome = await runVerification(store, note.id);
    expect(outcome.result).toBe('clean');
    const lines = markerLines().filter((line) => line.startsWith('verify '));
    expect(lines).toEqual(['verify active pre', 'verify verify post']);
  });

  test('review: pre and post on the reviewed card', async () => {
    const note = store.addNote('moment grid review');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'moment grid review',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: [],
      openQuestions: [],
    });
    await startVerb(store, note.id, 'feat');
    await reviewGate(store, note.id);
    const lines = markerLines().filter((line) => line.startsWith('review '));
    expect(lines).toEqual(['review active pre', 'review active post']);
  });

  test('archive: pre sees the pre-done lane, post sees done — and the legacy convention event still fires', async () => {
    // One legacy convention hook alongside the declared archive hooks: it
    // keeps firing exactly once, at the same post boundary.
    const legacy = join(dir, 'legacy.txt');
    const hook = join(dir, '.deck', 'hooks', 'onArchive', 'notify');
    mkdirSync(join(hook, '..'), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\necho legacy >> ${legacy}\n`);
    chmodSync(hook, 0o755);

    const note = store.addNote('moment grid archive');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'moment grid archive',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: [],
      openQuestions: [],
    });
    await startVerb(store, note.id, 'feat');
    store.syncTasks(note.id, [], 'engine');
    writeFileSync(join(dir, 'change.txt'), 'the change\n');
    git('add .');
    git('commit -m "feat: the change"');
    const outcome = await archiveVerb(store, note.id);
    expect(outcome.card.lane).toBe('done');

    const lines = markerLines().filter((line) => line.startsWith('archive '));
    expect(lines).toEqual(['archive active pre', 'archive done post']);
    expect(readFileSync(legacy, 'utf8')).toBe('legacy\n'); // fired once, not twice
  });
});

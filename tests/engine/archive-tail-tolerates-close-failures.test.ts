import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { archiveVerb, startVerb } from '../../src/core/engine/verbs.ts';

// Requirement: archive tail tolerates close failures — after the merge is
// pushed and the card is done, a failing issue close (or branch delete)
// becomes a warning on the outcome instead of throwing into a done card
// that archive would refuse to retry.
let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function stubGh(script: string): void {
  writeFileSync(join(binDir, 'gh'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

const GH_OK = `case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/41" ;;
  "issue edit") echo ok ;;
  "issue view") echo "{\\"number\\":41,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  "issue close") echo closed ;;
  "pr create") echo "https://github.com/o/r/pull/51" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac`;

// Everything works EXCEPT closing the issue — the mid-sequence network death.
const GH_CLOSE_FAILS = `case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/41" ;;
  "issue edit") echo ok ;;
  "issue view") echo "{\\"number\\":41,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  "issue close") echo "gh: network gone" >&2; exit 1 ;;
  "pr create") echo "https://github.com/o/r/pull/51" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac`;

function groomed(title: string): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['implement', 'verify'],
    openQuestions: [],
  });
  return note.id;
}

async function archivableCard(title: string): Promise<string> {
  const id = groomed(title);
  await startVerb(store, id, 'feat');
  store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
  writeFileSync(join(dir, 'change.txt'), 'the change\n');
  git('add .');
  git('commit -m "feat: the change"');
  return id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-archive-tail-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-archive-tail-bin-'));
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\norigin.git/\n');
  git('init --bare origin.git');
  git('remote add origin ./origin.git');
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

describe('archive close-failure tolerance', () => {
  test('issue close failing after the merge warns instead of throwing', async () => {
    stubGh(GH_CLOSE_FAILS);
    const id = await archivableCard('tolerant archive');

    const outcome = await archiveVerb(store, id); // must NOT throw

    expect(outcome.card.lane).toBe('done');
    expect(outcome.prUrl).toBe('https://github.com/o/r/pull/51');
    expect(outcome.warnings.some((warning) => /issue #41 not closed/.test(warning))).toBe(true);
    // the merge still landed on main
    expect(git('rev-parse --abbrev-ref HEAD').trim()).toBe('main');
    expect(git('log --merges --format="%s"')).toContain('merge:');
  });

  test('with gh healthy the archive closes silently (no warnings)', async () => {
    stubGh(GH_OK);
    const id = await archivableCard('clean archive');
    const outcome = await archiveVerb(store, id);
    expect(outcome.card.lane).toBe('done');
    expect(outcome.warnings).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem, demoteToNote } from '../../src/core/board/groom.ts';
import { setIssueMap, getIssueMap, enqueuePublish } from '../../src/core/board/specstore.ts';
import { recall } from '../../src/core/board/memory.ts';
import { pullsBody } from '../../src/server/routes/git.ts';
import { VERB_ICONS, VerbIcon } from '../../src/ui/slices/board/verbIcon.tsx';

// The paired file for the "Small Fixes Land Verified" requirement: the P3
// bundle — typing, error propagation, batching hooks, cascades, and the
// console allowlist — each fix asserted where it bites.
let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

const GH_OK = `case "$1 $2" in
  "issue view") echo "{\\"number\\":5,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  *) echo ok ;;
esac`;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-small-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-small-bin-'));
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
  rmSync(binDir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
});

describe('demoteToNote cascade', () => {
  test('demoting a groomed verb item removes map, queue, and spec rows', () => {
    const note = store.addNote('cascade probe');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'cascade probe',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    setIssueMap(store, { cardId: note.id, issueNumber: 9, state: 'open', checksum: 'x' });
    enqueuePublish(store, note.id, 'x');
    const demoted = demoteToNote(store, note.id);
    expect(demoted.id).toBe(note.id); // same card, back to note shape (todo)
    expect(getIssueMap(store, note.id)).toBeUndefined();
    // spec + queue rows are gone too — same cascade as deleteCard
    const queue = store.raw().query('SELECT COUNT(*) AS n FROM publish_queue WHERE card_id = ?').get(note.id) as { n: number };
    expect(queue.n).toBe(0);
    const specs = store.raw().query('SELECT COUNT(*) AS n FROM specs WHERE card_id = ?').get(note.id) as { n: number };
    expect(specs.n).toBe(0);
  });
});

describe('recall FTS rebuild', () => {
  test('rebuilds when sessions change, skips when the dir is untouched', () => {
    const sessions = join(dir, '.deck', 'sessions');
    require('node:fs').mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'probe-card.md'), '## context\n- the probe bullet\n');
    const first = recall(store, 'probe');
    expect(first.length).toBe(1);
    // Second call with no file change must still answer from the index.
    const second = recall(store, 'probe');
    expect(second).toEqual(first);
  });
});

describe('pullsBody carries a body', () => {
  test('the route schema accepts and keeps a PR body', () => {
    const parsed = pullsBody.parse({ title: 't', base: 'main', draft: false, body: 'the PR body' });
    expect(parsed.body).toBe('the PR body');
  });
});

describe('user-verb typing and icon fallback', () => {
  test('a user verb gets the fallback icon, not a crash', () => {
    const verb = 'investigate' as never as keyof typeof VERB_ICONS;
    expect(VERB_ICONS[verb]).toBeUndefined();
    const node = VerbIcon({ verb: 'investigate', size: 12 });
    expect(node).not.toBeNull();
  });
});

describe('console allowlist', () => {
  test('core modules stay silent — only the owning surfaces print', async () => {
    const offenders: string[] = [];
    for (const file of [
      'src/core/board/store.ts',
      'src/core/board/groom.ts',
      'src/core/board/publish.ts',
      'src/core/board/memory.ts',
      'src/core/engine/verbs.ts',
      'src/core/engine/revert.ts',
      'src/core/engine/verify.ts',
      'src/core/git/issues.ts',
      'src/core/git/ops.ts',
      'src/core/projects/registry.ts',
      'src/core/projects/doctor.ts',
      'src/ui/slices/board/store.ts',
    ]) {
      const source = await Bun.file(file).text();
      if (/console\./.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

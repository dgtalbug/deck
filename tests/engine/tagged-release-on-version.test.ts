import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveVerb, startVerb } from '../../src/core/engine/verbs.ts';
import { versionBumpedInDiff } from '../../src/core/engine/verify.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';

function checkTasks(store: DocumentStore, id: string): void {
  const card = store.getVerbItem(id);
  store.syncTasks(id, card.tasks.map((task) => ({ ...task, done: true })), 'engine');
}

// release-0-6-0 — the paired file for the "Tagged release on version bump"
// requirement: the archive tail detects a version bump in the archived
// diff, tags HEAD v<version>, pushes the tag, and emits the gh release —
// all best-effort; no bump → existing behavior.
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
if [ "$1 $2" = "release create" ]; then
  echo "$3" >> /dev/null
  releases="${'$'}{releases:-}"
  echo "$3" >> "${join(dir, 'releases.log')}"
  echo "https://github.com/o/r/releases/$3"
  exit 0
fi
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/21" ;;
  "issue view") echo "{"number":21,"state":"OPEN","labels":[{"name":"groomed"}],"url":"u"}" ;;
  "issue edit"|"issue close") echo ok ;;
  "pr create") echo "https://github.com/o/r/pull/31" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function groomed(title: string): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['implement', 'bump the package version'],
    openQuestions: [],
  });
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-tagged-release-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-tagged-release-bin-'));
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\norigin.git/\nreleases.log\n');
  git('init --bare origin.git');
  git('remote add origin ./origin.git');
  writeFileSync(join(dir, 'src-version.txt'), '0.5.0\n');
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

describe('tagged release on version bump', () => {
  test('a version bump in the diff → tag v<version> at HEAD + gh release', async () => {
    stubGh();
    const id = groomed('release bump card');
    await startVerb(store, id, 'feat');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.7.0' }));
    git('add .');
    git('commit -m "chore: bump 0.7.0"');
    checkTasks(store, id);
    const outcome = await archiveVerb(store, id);
    expect(outcome.card.lane).toBe('done');
    // tag created at (merge-commit) HEAD and pushed
    expect(git('tag --points-at HEAD').trim()).toBe('v0.7.0');
    expect(git('ls-remote --tags origin').trim()).toContain('refs/tags/v0.7.0');
    // the release fired with the tag name
    const releaseLog = join(dir, 'releases.log');
    expect((await Bun.file(releaseLog).text()).trim()).toBe('v0.7.0');
    expect(outcome.tail.release).toContain('v0.7.0');
  });

  test('no version bump → no tag, no release, archive unaffected', async () => {
    stubGh();
    const id = groomed('plain card');
    await startVerb(store, id, 'feat');
    writeFileSync(join(dir, 'b.txt'), 'plain change\n');
    git('add .');
    git('commit -m "feat: plain"');
    checkTasks(store, id);
    const outcome = await archiveVerb(store, id);
    expect(outcome.card.lane).toBe('done');
    expect(git('tag').trim()).toBe('');
    expect(outcome.tail.release).toBeNull();
  });

  test('versionBumpedInDiff reads the added version from package.json or version.ts', async () => {
    stubGh();
    const id = groomed('bump detection card');
    await startVerb(store, id, 'feat');
    writeFileSync(join(dir, 'src-version.txt'), 'ignored\n');
    const card = store.getVerbItem(id);
    expect(await versionBumpedInDiff(dir, card)).toBeNull(); // no version files touched
    writeFileSync(join(dir, 'package.json'), '{"version": "9.9.9"}');
    git('add .');
    git('commit -m "bump"');
    expect(await versionBumpedInDiff(dir, store.getVerbItem(id))).toBe('9.9.9');
  });
});

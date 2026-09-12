import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { startVerb } from '../../src/core/engine/verbs.ts';
import { getIssueMap } from '../../src/core/board/specstore.ts';

// The paired file for the "Start Verb Compensates Publish" requirement: a
// failed branch start leaves no standing issue-map row — the map is removed
// and the published issue is reported as drift, never silently forgotten.
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
  "issue create") echo "https://github.com/o/r/issues/77" ;;
  "issue view") echo "{\\"number\\":77,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
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
    tasks: ['one'],
    openQuestions: [],
  });
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-comp-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-comp-bin-'));
  stubGh();
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

describe('startVerb publish-side compensation', () => {
  test('branch failure removes the map row and reports the issue as drift', async () => {
    const id = groomed('compensate publish probe');
    // Pre-create the branch the start will try to create → git refuses.
    git('branch feat/compensate-publish-probe');
    let message = '';
    try {
      await startVerb(store, id, 'feat');
      expect.unreachable();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('already exists');
    expect(message).toContain('#77');
    expect(message).toContain('drift');
    // The card is back in groomed with no session file, and the map row is
    // gone — the only trace of the published issue is the drift report.
    expect(store.getVerbItem(id).lane).toBe('groomed');
    expect(getIssueMap(store, id)).toBeUndefined();
  });

  test('a clean start keeps the map row (compensation never over-fires)', async () => {
    const id = groomed('compensate publish clean');
    await startVerb(store, id, 'feat');
    expect(store.getVerbItem(id).lane).toBe('active');
    expect(getIssueMap(store, id)?.issueNumber).toBe(77);
  });
});

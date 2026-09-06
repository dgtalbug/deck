import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { startVerb } from '../../../src/core/engine/verbs.ts';
import { sessionPath } from '../../../src/core/board/memory.ts';

// memory-recall — the paired file for the "Session memory template"
// requirement: verb start scaffolds .deck/sessions/<cardId>.md byte-exact,
// refuses to overwrite lived-in memory, and compensation removes it.
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
    tasks: ['implement'],
    openQuestions: [],
  });
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-session-template-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-session-template-bin-'));
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

describe('session memory template', () => {
  test('verb start scaffolds the pinned session file byte-exact', async () => {
    stubGh();
    const id = groomed('session scaffold card');
    const outcome = await startVerb(store, id, 'feat');
    const path = sessionPath(dir, id);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(
      `card: ${id}\nverb: feat\nbranch: ${outcome.branch}\n\n## Learnings\n\n## Decisions\n\n## Gotchas\n`,
    );
  });

  test('a refused start compensates by removing the session file', async () => {
    stubGh();
    const id = groomed('dirty refusal card');
    writeFileSync(join(dir, 'dirt.txt'), 'dirty\n'); // dirty tree → refusal
    await expect(startVerb(store, id, 'feat')).rejects.toThrow(/not clean/);
    expect(existsSync(sessionPath(dir, id))).toBe(false);
    expect(store.getVerbItem(id).lane).toBe('groomed');
  });

  test('scaffold never overwrites lived-in memory', async () => {
    stubGh();
    const id = groomed('lived-in card');
    const path = sessionPath(dir, id);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, '.deck', 'sessions'), { recursive: true });
    writeFileSync(path, 'card: old\nverb: feat\nbranch: b\n\n## Learnings\n\n- hard-won lesson\n');
    await startVerb(store, id, 'feat');
    expect(readFileSync(path, 'utf8')).toContain('hard-won lesson');
  });
});
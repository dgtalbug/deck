import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { startVerb } from '../../src/core/engine/verbs.ts';
import { sessionPath } from '../../src/core/board/memory.ts';
import { DeckError } from '../../src/core/board/errors.ts';

// Requirement: duplicate branch names refuse with a retitle hint — under
// the four-word law two same-titled cards derive the same branch; the
// second start refuses as a typed DeckError naming the branch and the fix,
// with full compensation (card back in groomed, no session file).
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
  "issue create") echo "https://github.com/o/r/issues/$RANDOM" ;;
  "issue view") echo "{\\"number\\":1,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
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
    proposedVerb: 'fix',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['do it'],
    openQuestions: [],
  });
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-name-clash-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-name-clash-bin-'));
  git('init --initial-branch=main');
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

describe('duplicate branch refusal', () => {
  test('second same-titled card refuses with the branch named and a retitle fix', async () => {
    stubGh();
    const first = groomed('git page tabs');
    const started = await startVerb(store, first, 'fix');
    expect(started.branch).toBe('fix/git-page-tabs');
    git('switch main'); // leave the first branch checked out elsewhere

    const second = groomed('git page tabs'); // same four words
    await expect(startVerb(store, second, 'fix')).rejects.toThrow(DeckError);
    try {
      await startVerb(store, second, 'fix');
    } catch (error) {
      expect(error).toBeInstanceOf(DeckError);
      const message = (error as DeckError).message;
      expect(message).toContain('fix/git-page-tabs');
      expect(message).toMatch(/retitle/i);
    }
    // full compensation: card back in groomed, no session file, clean tree
    expect(store.getVerbItem(second).lane).toBe('groomed');
    expect(existsSync(sessionPath(dir, second))).toBe(false);
    expect(git('status --porcelain').trim()).toBe('');
  });
});

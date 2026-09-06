import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { archiveVerb, startVerb } from '../../src/core/engine/verbs.ts';

// verify-fix — the paired file for the "Queued publish archive message"
// requirement: archive with a queued offline publish prescribes deck sync,
// never 'run its verb start first'.
let dir: string;
let store: DocumentStore;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-queued-msg-'));
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, '.gitignore'), '.deck/\nspecs/\norigin.git/\n');
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
});

describe('queued publish archive message', () => {
  test('archive on a queued-publish card prescribes deck sync, mutates nothing', async () => {
    const prevGh = process.env['DECK_GH_BIN'];
    process.env['DECK_GH_BIN'] = '/nonexistent-gh'; // gh offline → publish queues
    try {
      const note = store.addNote('queued msg probe');
      convertToVerbItem(store, {
        noteId: note.id,
        proposedVerb: 'feat',
        refinedTitle: 'queued msg probe',
        research: { codebaseFindings: [] },
        specDeltas: [],
        tasks: ['task'],
        openQuestions: [],
      });
      await startVerb(store, note.id, 'feat'); // start runs, publish queues
      expect(store.getVerbItem(note.id).lane).toBe('active');
      await expect(archiveVerb(store, note.id)).rejects.toThrow(/still queued.*deck sync/s);
      // zero mutation: card stays active, branch intact
      expect(store.getVerbItem(note.id).lane).toBe('active');
      expect(git('rev-parse --abbrev-ref HEAD').trim()).toMatch(/^feat\//);
    } finally {
      if (prevGh !== undefined) process.env['DECK_GH_BIN'] = prevGh;
      else delete process.env['DECK_GH_BIN'];
    }
  });
});

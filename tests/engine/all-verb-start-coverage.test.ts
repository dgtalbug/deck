import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { startVerb, branchFor } from '../../src/core/engine/verbs.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { DeckError } from '../../src/core/board/errors.ts';
import { Verb, type Verb as VerbType } from '../../src/core/board/types.ts';

// verb-registrations — every verb in the const starts through the SAME core
// (zero verb-specific logic), and every cross-verb mismatch refuses. Paired
// file for the "All-verb start coverage" requirement.
let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;
let prevGh: string | undefined;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

const GH_OK = `case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/21" ;;
  "issue edit") echo ok ;;
  "issue view") echo "{"number":21,"state":"OPEN","labels":[{"name":"groomed"}],"url":"u"}" ;;
  "issue close") echo closed ;;
  "pr create") echo "https://github.com/o/r/pull/31" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac`;
function stubGh(script: string): void {
  writeFileSync(join(binDir, 'gh'), script);
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function groomed(title: string, verb: VerbType = 'feat'): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: verb,
    refinedTitle: title,
    research: verb === 'fix' ? { codebaseFindings: [], sections: { reproduce: 'steps', rca: 'cause' } } : { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['implement', 'verify'],
    openQuestions: [],
  });
  return note.id;
}


beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-allverbs-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-allverbs-bin-'));
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
  if (prevGh !== undefined) {
    process.env['DECK_GH_BIN'] = prevGh;
    prevGh = undefined;
  } else {
    delete process.env['DECK_GH_BIN'];
  }
});

describe('all-verb start coverage', () => {
  const allVerbs = Object.values(Verb);
  for (const verb of allVerbs) {
    test(`all-verb coverage: ${verb} starts on the shared engine`, async () => {
      stubGh(GH_OK);
      const id = groomed(`start ${verb}`, verb);
      const outcome = await startVerb(store, id, verb);
      expect(outcome.card.lane).toBe('active');
      expect(outcome.branch).toBe(branchFor(outcome.card, verb));
      expect(git('rev-parse --abbrev-ref HEAD').trim()).toBe(outcome.branch);
      git('switch main'); // next iteration needs a groomed-only lane + clean base
      moveLane(store, id, 'groomed', 'engine');
    });
    if (verb !== 'feat') {
      test(`all-verb coverage: feat refuses a ${verb} card`, async () => {
        stubGh(GH_OK);
        const id = groomed(`mismatch ${verb}`, verb);
        await expect(startVerb(store, id, 'feat')).rejects.toThrow(DeckError);
        expect(store.getVerbItem(id).lane).toBe('groomed');
      });
    }
  }
});

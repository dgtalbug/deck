import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import { openRevertDoor } from '../../src/core/engine/revert.ts';
import { parseRequirementNames } from '../../src/core/engine/verify.ts';
import { DeckError } from '../../src/core/board/errors.ts';
import type { Delta } from '../../src/core/board/types.ts';

// The paired file for the "Done Cards Revert Through A Door" requirement:
// deck revert <done-card-id> materializes a NEW groomed revert-verb card
// whose story, tasks, and spec deltas re-derive from the archived merge
// commit — the revert itself stays a reviewed change.
let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/101" ;;
  "issue view") echo "{\\"number\\":101,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

async function seedArchivedCard(title: string, specDeltas: Delta[]): Promise<string> {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas,
    tasks: ['build the thing'],
    openQuestions: [],
  });
  await publishSpec(store, note.id);
  moveLane(store, note.id, 'active', 'engine');
  moveLane(store, note.id, 'verify', 'engine');
  moveLane(store, note.id, 'done', 'engine');
  return note.id;
}

function archiveInGit(title: string): string {
  // Mimic the engine's archive shape: a --no-ff merge whose SUBJECT embeds
  // the card title (`merge: <branch> — <title>`).
  git('checkout -q -b probe/feature-branch');
  writeFileSync(join(dir, 'probe-file.txt'), 'change\n');
  git('add .');
  git('commit -q -m "feat: probe"');
  git('checkout -q main');
  git(`merge --no-ff -q -m "merge: probe/feature-branch — ${title}" probe/feature-branch`);
  return git('rev-parse HEAD').trim();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-revert-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-revert-bin-'));
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

describe('openRevertDoor', () => {
  test('creates a groomed revert card derived from the archived merge', async () => {
    const sha = archiveInGit('door probe change');
    const doneId = await seedArchivedCard('door probe change', [
      { op: 'ADDED', requirement: 'Requirement: Door Probe Change', text: 'it works' },
    ]);
    const outcome = await openRevertDoor(store, dir, doneId);
    expect(outcome.mergeSha).toBe(sha);
    expect(outcome.card.verb).toBe('revert');
    expect(outcome.card.lane).toBe('groomed');
    expect(outcome.card.id).not.toBe(doneId);
    expect(outcome.card.title).toBe('revert door probe change');
    // the merge sha is recorded so the card re-derives
    expect(outcome.card.research.codebaseFindings.join('\n')).toContain(sha);
    // tasks carry the revert command
    const titles = outcome.card.tasks.map((task) => task.title).join('\n');
    expect(titles).toContain(`git revert -m 1 ${sha}`);
    // spec honesty: the original requirement comes back in the task list
    expect(titles).toContain('Door Probe Change');
  });

  test('spec deltas flip every original requirement to REMOVED', async () => {
    archiveInGit('delta flip change');
    const doneId = await seedArchivedCard('delta flip change', [
      { op: 'ADDED', requirement: 'Requirement: Delta Flip Change', text: 'it works' },
    ]);
    const outcome = await openRevertDoor(store, dir, doneId);
    const { newestSpecVersion } = await import('../../src/core/board/specstore.ts');
    const version = newestSpecVersion(store, outcome.card.id);
    expect(version).toBeDefined();
    const markdown = version!.markdown;
    expect(markdown).toContain('### REMOVED: Requirement: Delta Flip Change');
    expect(parseRequirementNames(markdown)).toEqual(['Delta Flip Change']);
  });

  test('attaches to the same epic when the done card had one', async () => {
    archiveInGit('epic attach change');
    const doneId = await seedArchivedCard('epic attach change', []);
    const epic = store.addEpic('probe epic');
    store.setEpic(doneId, epic.id);
    const outcome = await openRevertDoor(store, dir, doneId);
    expect(outcome.card.epicId).toBe(epic.id);
  });

  test('refuses on a card that is not done', async () => {
    const note = store.addNote('not done change');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'not done change',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['task'],
      openQuestions: [],
    });
    await expect(openRevertDoor(store, dir, note.id)).rejects.toThrow(DeckError);
    await expect(openRevertDoor(store, dir, note.id)).rejects.toThrow(/is in groomed/);
  });

  test('refuses honestly when no merge subject matches the title', async () => {
    const doneId = await seedArchivedCard('never archived change', []);
    await expect(openRevertDoor(store, dir, doneId)).rejects.toThrow(/no merge commit found/);
  });

  test('matches on the merge subject, not the branch name', async () => {
    // legacy shape: id-named branch, title only in the merge SUBJECT
    git('checkout -q -b probe/some-legacy-id-shape');
    writeFileSync(join(dir, 'legacy.txt'), 'legacy\n');
    git('add .');
    git('commit -q -m "feat: legacy"');
    git('checkout -q main');
    git('merge --no-ff -q -m "merge: probe/some-legacy-id-shape — subject match probe" probe/some-legacy-id-shape');
    const sha = git('rev-parse HEAD').trim();
    const doneId = await seedArchivedCard('subject match probe', []);
    const outcome = await openRevertDoor(store, dir, doneId);
    expect(outcome.mergeSha).toBe(sha);
  });
});

describe('deck revert CLI door', () => {
  test('done card opens the door; groomed card starts a normal build', async () => {
    const { runCli } = await import('../../src/cli/main.ts');
    const { ProjectRegistry } = await import('../../src/core/projects/registry.ts');
    const registry = new ProjectRegistry();
    registry.register(dir);
    const out: string[] = [];
    const io = { out: (t: string) => out.push(t), err: (t: string) => out.push(t) };

    const sha = archiveInGit('cli door change');
    const doneId = await seedArchivedCard('cli door change', []);
    const code = await runCli(['revert', doneId], { registry, cwd: dir, io });
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('revert door opened — revert cli door change');
    expect(text).toContain(sha.slice(0, 10));

    // the new groomed card starts a normal reviewed revert build
    const newId = text.match(/card\s+(\S+)\s+→ groomed/)![1]!;
    expect(store.getVerbItem(newId).lane).toBe('groomed');
  });
});

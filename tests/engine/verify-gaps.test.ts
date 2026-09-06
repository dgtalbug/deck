import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveLane } from '../../src/core/board/lanes.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { computeGaps, parseRequirementNames } from '../../src/core/engine/verify.ts';
import type { Delta } from '../../src/core/board/types.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import { DeckError } from '../../src/core/board/errors.ts';

// Tasks 1.2 — deterministic gap computation: unchecked task is a gap,
// orphan requirement is a gap, non-verify card refuses.
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

interface Seeded {
  id?: string;
  tasks: string[];
  specDeltas: Delta[];
}

async function seedVerifyCard(title: string, { tasks, specDeltas }: Seeded): Promise<string> {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas,
    tasks,
    openQuestions: [],
  });
  await publishSpec(store, note.id); // records the spec version
  moveLane(store, note.id, 'active', 'engine');
  moveLane(store, note.id, 'verify', 'engine');
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-gaps-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-gaps-bin-'));
  git('init --initial-branch=main -q');
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

describe('computeGaps', () => {
  test('unchecked task is a gap carrying its evidence', async () => {
    stubGh();
    const id = await seedVerifyCard('gap card unchecked', {
      tasks: ['implement the thing'],
      specDeltas: [],
    });
    const gaps = computeGaps(store, id);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.taskTitle).toBe('implement the thing');
    expect(gaps[0]!.evidence).toMatch(/^t-/);
  });

  test('requirement with no task reference and no paired test is a gap', async () => {
    stubGh();
    const id = await seedVerifyCard('orphan requirement card', {
      tasks: [],
      specDeltas: [
        { op: 'ADDED' as const, requirement: 'Requirement: Widget Export Format', text: 'The widget SHALL export.' },
      ],
    });
    const gaps = computeGaps(store, id);
    const orphan = gaps.find((gap) => gap.requirement !== undefined);
    expect(orphan).toBeDefined();
    expect(orphan!.requirement).toBe('Widget Export Format');
    expect(orphan!.evidence).toBe('none');
  });

  test('requirement referenced by a task is not a gap', async () => {
    stubGh();
    const id = await seedVerifyCard('referenced requirement card', {
      tasks: ['implement the widget export format endpoint'],
      specDeltas: [
        { op: 'ADDED' as const, requirement: 'Requirement: Widget Export Format', text: 'The widget SHALL export.' },
      ],
    });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    const gaps = computeGaps(store, id);
    expect(gaps).toEqual([]);
  });

  test('non-verify card is a typed refusal', async () => {
    stubGh();
    const note = store.addNote('groomed only');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'groomed only',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['work'],
      openQuestions: [],
    });
    expect(() => computeGaps(store, note.id)).toThrow(DeckError);
  });
});

describe('parseRequirementNames', () => {
  test('extracts requirement headers from spec markdown', () => {
    const markdown = '# t\n\n### Requirement: One\nx\n\n#### Scenario: a\n\n### Requirement: Two Words Here\ny\n';
    expect(parseRequirementNames(markdown)).toEqual(['One', 'Two Words Here']);
  });
});

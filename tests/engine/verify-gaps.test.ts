import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveLane } from '../../src/core/board/lanes.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { computeGaps, parseRequirementNames, runVerification } from '../../src/core/engine/verify.ts';
import { captureCheckEvidence } from '../../src/core/engine/evidence.ts';
import { enrollPolicy } from '../../src/core/board/rules.ts';
import { scopeCriteria } from '../../src/core/board/scope.ts';
import type { Delta } from '../../src/core/board/types.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import { DeckError } from '../../src/core/board/errors.ts';

// Task 2.10 (with 2.9) — evidence-backed gap computation: a matching filename
// is never proof, criteria need current linked evidence, repeated gaps dedupe
// their repair tasks, and ordinary clean stays in verify.
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

function writeRules(): void {
  writeFileSync(
    join(dir, 'deck.rules.yaml'),
    ['version: 1', 'principles:', '  - id: unit-tests', '    rule: tests pass', '    check: exit 0'].join('\n'),
  );
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

const WIDGET: Delta = {
  op: 'ADDED' as const,
  requirement: 'Requirement: Widget Export Format',
  text: 'The widget SHALL export.',
};

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
    const gaps = await computeGaps(store, id);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.taskTitle).toBe('implement the thing');
    expect(gaps[0]!.evidence).toMatch(/^t-/);
  });

  test('empty matching test file is still a gap — filenames are not proof', async () => {
    stubGh();
    const id = await seedVerifyCard('orphan requirement card', {
      tasks: [],
      specDeltas: [WIDGET],
    });
    // A matching filename exists in the worktree — under the old law this
    // silenced the gap; it never will again.
    writeFileSync(join(dir, 'widget-export-format.spec.ts'), 'export {};\n');
    const gaps = await computeGaps(store, id);
    const orphan = gaps.find((gap) => gap.evidence === 'policy-unenrolled');
    expect(orphan).toBeDefined();
    expect(orphan!.taskTitle).toContain('policy');
  });

  test('enrolled policy with classified criterion: missing evidence gap carries the criterion id', async () => {
    stubGh();
    writeRules();
    const id = await seedVerifyCard('evidence missing card', { tasks: [], specDeltas: [WIDGET] });
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    const criterion = scopeCriteria(store.db, id).find((item) => item.state === 'active')!;
    const gaps = await computeGaps(store, id);
    const orphan = gaps.find((gap) => gap.requirement !== undefined);
    expect(orphan).toBeDefined();
    expect(orphan!.criterionId).toBe(criterion.id);
    expect(orphan!.evidenceStatus).toBe('missing');
    expect(orphan!.taskTitle).toContain(criterion.id);
  });

  test('differently named executed test with linked evidence satisfies the criterion', async () => {
    stubGh();
    writeRules();
    const id = await seedVerifyCard('differently named card', { tasks: [], specDeltas: [WIDGET] });
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    // The check is named `unit-tests`, nothing like the requirement title —
    // explicit linking is what satisfies, not the name.
    await captureCheckEvidence(store, id, { checkId: 'unit-tests' });
    const gaps = await computeGaps(store, id);
    expect(gaps.find((gap) => gap.requirement !== undefined)).toBeUndefined();
  });

  test('byte change after capture makes the evidence stale again', async () => {
    stubGh();
    writeRules();
    const id = await seedVerifyCard('stale evidence card', { tasks: [], specDeltas: [WIDGET] });
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    await captureCheckEvidence(store, id, { checkId: 'unit-tests' });
    expect((await computeGaps(store, id)).find((gap) => gap.requirement !== undefined)).toBeUndefined();
    writeFileSync(join(dir, 'a.txt'), 'two\n'); // dirty byte change, same paths
    const gaps = await computeGaps(store, id);
    expect(gaps.find((gap) => gap.requirement !== undefined)?.evidenceStatus).toBe('stale');
  });

  test('repeated evidence gaps do not duplicate repair tasks', async () => {
    stubGh();
    writeRules();
    const id = await seedVerifyCard('repeated gap card', { tasks: ['build the widget'], specDeltas: [WIDGET] });
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    const first = await runVerification(store, id);
    expect(first.result).toBe('gaps');
    expect(first.card.lane).toBe('active');
    moveLane(store, id, 'verify', 'engine');
    const second = await runVerification(store, id);
    expect(second.result).toBe('gaps');
    const repairTasks = second.card.tasks.filter((task) => task.title.includes('provide evidence for'));
    expect(repairTasks).toHaveLength(1);
  });

  test('current evidence and completed tasks keep ordinary clean in verify', async () => {
    stubGh();
    writeRules();
    const id = await seedVerifyCard('clean holds card', { tasks: ['build the widget'], specDeltas: [WIDGET] });
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    await captureCheckEvidence(store, id, { checkId: 'unit-tests' });
    const outcome = await runVerification(store, id);
    expect(outcome.result).toBe('clean');
    expect(outcome.card.lane).toBe('verify'); // done is finalization's alone
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
    await expect(computeGaps(store, note.id)).rejects.toThrow(DeckError);
  });
});

describe('parseRequirementNames', () => {
  test('extracts requirement headers from spec markdown', () => {
    const markdown = '# t\n\n### Requirement: One\nx\n\n#### Scenario: a\n\n### Requirement: Two Words Here\ny\n';
    expect(parseRequirementNames(markdown)).toEqual(['One', 'Two Words Here']);
  });
});

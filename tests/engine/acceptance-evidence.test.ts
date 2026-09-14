import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveLane } from '../../src/core/board/lanes.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { recordScopeRevision, scopeCriteria } from '../../src/core/board/scope.ts';
import { enrollPolicy, recordOverride } from '../../src/core/board/rules.ts';
import {
  captureCheckEvidence,
  evaluateEligibility,
  listEvidence,
  recordManualEvidence,
} from '../../src/core/engine/evidence.ts';
import { reviewGate } from '../../src/core/engine/verify.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import type { Delta } from '../../src/core/board/types.ts';

// Tasks 2.6 + 2.8 — attributable acceptance evidence: failed commands,
// wrong criterion links, explicit manual attribution, stale scope/policy,
// mutating checks, unavailable artifacts, and review capture ownership.
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
  "issue create") echo "https://github.com/o/r/issues/103" ;;
  "issue view") echo "{\\"number\\":103,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function writeRules(check: string): void {
  writeFileSync(
    join(dir, 'deck.rules.yaml'),
    ['version: 1', 'principles:', '  - id: unit-tests', '    rule: tests pass', `    check: ${check}`].join('\n'),
  );
}

const WIDGET: Delta = {
  op: 'ADDED' as const,
  requirement: 'Requirement: Widget Export Format',
  text: 'The widget SHALL export.',
};

async function seed(): Promise<string> {
  const note = store.addNote('evidence card');
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: 'evidence card',
    research: { codebaseFindings: [] },
    specDeltas: [WIDGET],
    tasks: [],
    openQuestions: [],
  });
  await publishSpec(store, note.id);
  moveLane(store, note.id, 'active', 'engine');
  moveLane(store, note.id, 'verify', 'engine');
  return note.id;
}

function activeCriterion(id: string): string {
  return scopeCriteria(store.db, id).find((item) => item.state === 'active')!.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-acceptance-evidence-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-acceptance-bin-'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m "c1"');
  stubGh();
  store = await openStore(dir);
  writeRules('exit 0');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
});

describe('machine evidence', () => {
  test('failed command records failed and blocks the criterion', async () => {
    const id = await seed();
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    writeRules('exit 3');
    const records = await captureCheckEvidence(store, id, { checkId: 'unit-tests' });
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.result === 'failed')).toBe(true);
    const evaluation = await evaluateEligibility(store, id);
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.criteria[0]!.status).toBe('failed');
  });

  test('evidence linked to a criterion outside current scope refuses', async () => {
    const id = await seed();
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    await expect(captureCheckEvidence(store, id, { checkId: 'unit-tests', criteria: ['c-nope'] })).rejects.toThrow(
      /not an active criterion/,
    );
  });

  test('capture without an enrolled policy refuses', async () => {
    const id = await seed();
    await expect(captureCheckEvidence(store, id, { checkId: 'unit-tests' })).rejects.toThrow(/no enrolled/);
  });

  test('check id outside the configured runner refuses', async () => {
    const id = await seed();
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    await expect(captureCheckEvidence(store, id, { checkId: 'not-a-check' })).rejects.toThrow(
      /not a machine-checked principle/,
    );
  });

  test('mutating checks invalidate their own result (pre/post mismatch)', async () => {
    const id = await seed();
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    writeRules('echo mutated >> a.txt');
    const records = await captureCheckEvidence(store, id, { checkId: 'unit-tests' });
    expect(records.every((record) => record.result === 'unavailable')).toBe(true);
    const evaluation = await evaluateEligibility(store, id);
    expect(evaluation.criteria[0]!.status).toBe('unavailable');
    expect(evaluation.eligible).toBe(false);
  });

  test('missing required artifact records explicit unavailability', async () => {
    const id = await seed();
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    const records = await captureCheckEvidence(store, id, {
      checkId: 'unit-tests',
      artifactPath: join(dir, 'missing-artifact.json'),
    });
    expect(records[0]!.artifactUnavailable).toBe('missing');
    expect(records[0]!.artifactSha256).toBeNull();
  });

  test('unchanged policy version keeps history attributable but not satisfying after byte drift', async () => {
    const id = await seed();
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    await captureCheckEvidence(store, id, { checkId: 'unit-tests' });
    expect((await evaluateEligibility(store, id)).eligible).toBe(true);
    writeFileSync(join(dir, 'a.txt'), 'changed bytes\n');
    const evaluation = await evaluateEligibility(store, id);
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.criteria[0]!.status).toBe('stale');
    // The old record is still readable — history stays attributable.
    expect(listEvidence(store, id)).toHaveLength(1);
  });

  test('policy change (version bump) invalidates records bound to the older policy', async () => {
    const id = await seed();
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    await captureCheckEvidence(store, id, { checkId: 'unit-tests' });
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] }); // v2
    const evaluation = await evaluateEligibility(store, id);
    expect(evaluation.criteria[0]!.status).toBe('stale');
    expect(evaluation.eligible).toBe(false);
  });

  test('scope revision bump invalidates records bound to the older scope', async () => {
    const id = await seed();
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    await captureCheckEvidence(store, id, { checkId: 'unit-tests' });
    // A reviewed scope edit records a new immutable revision.
    const card = store.getVerbItem(id);
    recordScopeRevision(
      store.db,
      id,
      {
        verb: card.verb,
        title: card.title,
        // The reviewed edit adds a task — a digest change is what versions.
        tasks: [...card.tasks.map((task) => ({ id: task.id, title: task.title })), { id: 't-new', title: 'extra reviewed task' }],
        criteria: scopeCriteria(store.db, id)
          .filter((item) => item.state === 'active')
          .map((item) => ({ id: item.id, state: item.state, title: item.title })),
      },
      ['reviewed edit: extra task'],
    );
    const evaluation = await evaluateEligibility(store, id);
    expect(evaluation.criteria[0]!.status).toBe('stale');
  });
});

describe('manual evidence', () => {
  test('explicit manual criterion with attributed review satisfies without machine claims', async () => {
    const id = await seed();
    const criterionId = activeCriterion(id);
    enrollPolicy(store, id, { mode: 'team', manualCriteria: [criterionId] });
    const record = await recordManualEvidence(store, id, {
      criterionId,
      reviewer: 'dana',
      rationale: 'reviewed the export format against the spec by hand',
    });
    expect(record.kind).toBe('manual');
    expect(record.reviewer).toBe('dana');
    expect(record.result).toBe('passed');
    const evaluation = await evaluateEligibility(store, id);
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.criteria[0]!.requirement).toBe('manual');
  });

  test('manual review cannot satisfy a machine-required criterion', async () => {
    const id = await seed();
    const criterionId = activeCriterion(id);
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    await expect(
      recordManualEvidence(store, id, { criterionId, reviewer: 'dana', rationale: 'looks fine' }),
    ).rejects.toThrow(/not designated manual/);
  });

  test('a failed automated check stays blocking even with a reviewer sign-off on record', async () => {
    const id = await seed();
    const criterionId = activeCriterion(id);
    // Designated manual: manual records are accepted for it…
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'], manualCriteria: [criterionId] });
    writeRules('exit 2');
    // …but a machine record linked to the criterion records the failure…
    const records = await captureCheckEvidence(store, id, { checkId: 'unit-tests', criteria: [criterionId] });
    expect(records[0]!.result).toBe('failed');
    // …and the requirement stays machine-blocking in the evaluation.
    const evaluation = await evaluateEligibility(store, id);
    expect(evaluation.criteria[0]!.status).toBe('failed');
    expect(evaluation.eligible).toBe(false);
  });
});

describe('review ownership of evidence capture', () => {
  test('reviewGate captures required checks as evidence records', async () => {
    const id = await seed();
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    const findings = await reviewGate(store, id);
    expect(findings.find((finding) => finding.violates.startsWith('evidence:'))).toBeUndefined();
    expect(listEvidence(store, id).length).toBeGreaterThan(0);
    const evaluation = await evaluateEligibility(store, id);
    expect(evaluation.eligible).toBe(true);
  });

  test('a recorded override cannot bypass a policy-required check', async () => {
    const id = await seed();
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    writeRules('exit 4');
    recordOverride(store, id, 'unit-tests', 'user decision: skip this once');
    const findings = await reviewGate(store, id);
    // The override silences the plain rules finding, but the evidence capture
    // still runs and records the failure — the criterion stays blocked.
    expect(findings.find((finding) => finding.violates === 'evidence: unit-tests')).toBeDefined();
    const evaluation = await evaluateEligibility(store, id);
    expect(evaluation.criteria[0]!.status).toBe('failed');
  });
});

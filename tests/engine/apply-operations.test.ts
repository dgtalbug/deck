// Controlled apply: revision-bound start/status/resume/cancel, durable
// checkpoint authority with Markdown projection, and atomic evidence runs.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { applyScopeEdit } from '../../src/core/board/accepted-scope.ts';
import { getPolicy } from '../../src/core/board/rules.ts';
import {
  beginEvidenceRun,
  cancelApply,
  completeEvidenceRun,
  currentApply,
  EvidenceRunPayloadConflictError,
  importCheckpointFile,
  listDurableCheckpoints,
  listEvidenceRuns,
  MissingAcceptedBasisError,
  recordCheckpoint,
  resumeApply,
  startApply,
  StaleApplyBasisError,
} from '../../src/core/engine/apply.ts';
import { readCheckpoint, writeCheckpoint } from '../../src/core/board/checkpoint.ts';

let dir: string;
let store: DocumentStore;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function groomed(title: string, tasks: string[]): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks,
    openQuestions: [],
  });
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-apply-'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), '.deck/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m "c1"');
  store = await openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('apply operation basis', () => {
  test('start records the accepted basis before mutating execution state', async () => {
    const id = groomed('apply basis card', ['do the work']);
    const { operation, basis } = await startApply(store, id, { owner: 'agent-1' });
    expect(operation.kind).toBe('apply');
    expect(basis.acceptedRevision).toBe(1);
    expect(basis.revisionId).toMatch(/^sr-/);
    expect(basis.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(basis.impactBasis).toBe('missing'); // no impact snapshot captured
    expect(basis.branch).toBe('main');
    expect(basis.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(basis.dependenciesReady).toBe(true);
    expect(currentApply(store, id)?.id).toBe(operation.id);
  });

  test('cards without accepted scope refuse to start', async () => {
    const note = store.addNote('unclassified apply card');
    await expect(startApply(store, note.id)).rejects.toThrow(MissingAcceptedBasisError);
  });

  test('dirty checkout refuses under the default input policy', async () => {
    const id = groomed('dirty apply card', ['task']);
    writeFileSync(join(dir, 'uncommitted.txt'), 'dirty\n');
    await expect(startApply(store, id)).rejects.toThrow(/dirty and the apply input policy refuses/);
    expect(currentApply(store, id)).toBeNull();
    const allowed = await startApply(store, id, { dirtyPolicy: 'allow' });
    expect(allowed.basis.dirtyPolicy).toBe('allow');
  });

  test('one active apply per card; second start refuses', async () => {
    const id = groomed('single apply card', ['task']);
    await startApply(store, id);
    await expect(startApply(store, id)).rejects.toThrow(/already has active apply operation/);
  });

  test('interrupted apply resumes the same identity with remaining work and no duplicate effects', async () => {
    const id = groomed('resume card', ['first task', 'second task']);
    const { operation } = await startApply(store, id);
    const card = store.getVerbItem(id);
    store.syncTasks(id, card.tasks.map((task, index) => ({ ...task, done: index === 0 })), 'engine');
    const resumed = await resumeApply(store, id);
    expect(resumed.operation?.id).toBe(operation.id);
    expect(resumed.remainingTasks.map((task) => task.title)).toEqual(['second task']);
    expect(currentApply(store, id)?.id).toBe(operation.id);
  });

  test('scope change under an apply makes the basis stale and refuses resume/mutation', async () => {
    const id = groomed('stale apply card', ['task']);
    await startApply(store, id);
    applyScopeEdit(store.db, id, {
      operations: [{ kind: 'requirement', op: 'add', title: 'late requirement', body: 'more' }],
      actor: 'human',
    });
    await expect(resumeApply(store, id)).rejects.toThrow(StaleApplyBasisError);
    const status = await import('../../src/core/engine/apply.ts').then((m) => m.applyStatus(store, id));
    expect(status.basis).toBe('stale');
  });

  test('cancel compensates and preserves unrelated state', async () => {
    const id = groomed('cancel card', ['task']);
    const other = groomed('unrelated card', ['other task']);
    const { operation } = await startApply(store, id);
    recordCheckpoint(store, { cardId: id, kind: 'decision', text: 'context worth keeping', actor: 'agent' });
    const cancelled = cancelApply(store, id);
    expect(cancelled.state).toBe('cancelled');
    expect(currentApply(store, id)).toBeNull();
    // History and unrelated card state survive cancellation.
    expect(listDurableCheckpoints(store, id).length).toBe(1);
    expect(store.getVerbItem(other).lane).toBe('groomed');
    void operation;
    expect(() => cancelApply(store, id)).toThrow(/no active apply operation to cancel/);
  });
});

describe('durable checkpoints', () => {
  test('DB-before-file crash keeps durable authority with a pending projection', async () => {
    const id = groomed('db first card', ['task']);
    const record = recordCheckpoint(store, { cardId: id, kind: 'gotcha', text: 'pitfall noted', actor: 'agent', project: false });
    expect(record.projection).toBe('pending');
    // The durable row answers even though the Markdown file was never written.
    const durable = listDurableCheckpoints(store, id);
    expect(durable).toHaveLength(1);
    expect(durable[0]!.text).toBe('pitfall noted');
    expect(existsSync(join(dir, '.deck', 'sessions', `${id}.md`))).toBe(false);
    // Projection catches up idempotently.
    const { projectCheckpoint } = await import('../../src/core/engine/apply.ts');
    projectCheckpoint(store, durable[0]);
    projectCheckpoint(store, durable[0]);
    const state = readCheckpoint(dir, id);
    expect(state.managed).toBe(true);
    expect(state.entries[0]!.id).toBe(record.id);
    expect(listDurableCheckpoints(store, id)[0]!.projection).toBe('projected');
  });

  test('file-before-DB markdown never gains checkpoint authority', async () => {
    const id = groomed('file first card', ['task']);
    writeCheckpoint(dir, id, { text: 'stray projection', kind: 'remaining' });
    const imported = importCheckpointFile(store, id);
    // A valid managed region imports as unknown provenance, not current authority.
    expect(imported.imported).toBe(1);
    expect(imported.unknown).toBe(true);
    const rows = listDurableCheckpoints(store, id);
    expect(rows[0]!.projection).toBe('unknown');
    expect(rows[0]!.actor).toBe('legacy-import');
  });

  test('malformed managed region refuses import and preserves the file', () => {
    const id = groomed('malformed fence card', ['task']);
    const sessions = join(dir, '.deck', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, `${id}.md`),
      `card: ${id}\n\n## Checkpoint\n<!-- deck:checkpoint rev=3 -->\n- [id=bad] kind=decision basis=weird unterminated\n`,
    );
    const before = readFileSync(join(sessions, `${id}.md`), 'utf8');
    const state = readCheckpoint(dir, id);
    expect(state.managed).toBe(false); // unterminated fence is not a valid region
    const imported = importCheckpointFile(store, id);
    expect(imported.imported).toBe(0);
    expect(readFileSync(join(sessions, `${id}.md`), 'utf8')).toBe(before);
  });
});

describe('evidence runs', () => {
  test('multi-criterion run commits atomically and satisfies criteria together', async () => {
    const id = groomed('run card', ['task']);
    enrollPolicy(id);
    const inputs = await captureInputs();
    const run = beginEvidenceRun(store, { cardId: id, producer: 'suite', checkType: 'machine', checkId: 'tests', inputFingerprint: inputs, policyVersion: getPolicy(store, id)!.version });
    expect(run.state).toBe('incomplete');
    const criteria = store.getVerbItem(id); // placeholder to keep types honest
    void criteria;
    const completed = completeEvidenceRun(store, {
      runId: run.id,
      result: 'passed',
      criteria: ['c-one', 'c-two'],
    });
    expect(completed.state).toBe('complete');
    expect(completed.links.map((link) => link.criterionId).sort()).toEqual(['c-one', 'c-two']);
  });

  test('incomplete runs stay visible and never satisfy completion', async () => {
    const id = groomed('incomplete run card', ['task']);
    enrollPolicy(id);
    const inputs = await captureInputs();
    const run = beginEvidenceRun(store, { cardId: id, producer: 'suite', checkType: 'machine', inputFingerprint: inputs, policyVersion: getPolicy(store, id)!.version });
    const runs = listEvidenceRuns(store, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe('incomplete');
    const { completionInvariant } = await import('../../src/core/engine/apply.ts');
    const invariant = await completionInvariant(store, id);
    expect(invariant.satisfied).toBe(false);
    expect(invariant.blockers.some((blocker) => blocker.includes('incomplete evidence run'))).toBe(true);
  });

  test('retry with the same payload is idempotent; changed payload under the same identity refuses', async () => {
    const id = groomed('retry card', ['task']);
    enrollPolicy(id);
    const inputs = await captureInputs();
    const run = beginEvidenceRun(store, { cardId: id, producer: 'suite', checkType: 'machine', inputFingerprint: inputs, policyVersion: getPolicy(store, id)!.version });
    const first = completeEvidenceRun(store, { runId: run.id, result: 'passed', criteria: ['c-one'] });
    const retry = completeEvidenceRun(store, { runId: run.id, result: 'passed', criteria: ['c-one'] });
    expect(retry.id).toBe(first.id);
    expect(listEvidenceRuns(store, id)).toHaveLength(1);
    expect(() => completeEvidenceRun(store, { runId: run.id, result: 'failed', criteria: ['c-one'] })).toThrow(EvidenceRunPayloadConflictError);
    // Same payload under a different run id returns the recorded run without duplicating links.
    const second = beginEvidenceRun(store, { cardId: id, producer: 'suite', checkType: 'machine', inputFingerprint: inputs, policyVersion: getPolicy(store, id)!.version });
    const deduped = completeEvidenceRun(store, { runId: second.id, result: 'passed', criteria: ['c-one'] });
    expect(deduped.id).toBe(first.id);
  });

  async function captureInputs(): Promise<string> {
    const { captureExecutionInputs } = await import('../../src/core/engine/evidence-inputs.ts');
    return (await captureExecutionInputs(dir, { declaredInputs: [] })).fingerprint;
  }

  function enrollPolicy(cardId: string): void {
    // enrollPolicy needs board/rules; mode solo keeps the provider out of the way.
    const { enrollPolicy } = require('../../src/core/board/rules.ts') as typeof import('../../src/core/board/rules.ts');
    enrollPolicy(store, cardId, { mode: 'solo' });
  }
});

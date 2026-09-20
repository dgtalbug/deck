// Evidence-backed completion: the invariant blocks overstated completion,
// holds clean verification for finalization, records one completion identity,
// and separates local completion from provider delivery and archive tails.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { enrollPolicy } from '../../src/core/board/rules.ts';
import { applyScopeEdit, scopeCriteria } from '../../src/core/board/accepted-scope.ts';
import {
  beginEvidenceRun,
  completeEvidenceRun,
  CompletionBlockedError,
  completionInvariant,
  currentCompletion,
  listCompletions,
  recordCompletion,
} from '../../src/core/engine/apply.ts';
import { captureExecutionInputs } from '../../src/core/engine/evidence-inputs.ts';

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
  "issue create") echo "https://github.com/o/r/issues/303" ;;
  "issue view") echo "{\\"number\\":303,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  "issue edit"|"issue close") echo ok ;;
  "pr create") echo "https://github.com/o/r/pull/304" ;;
  "pr list") echo "[]" ;;
  "auth status") exit 0 ;;
  "release create") echo "https://github.com/o/r/releases/tag/v9.9.9" ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function groomed(title: string, tasks: string[]): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [{ op: 'ADDED', requirement: 'The feature SHALL work', text: 'body' }],
    tasks,
    openQuestions: [],
  });
  return note.id;
}

async function fingerprint(): Promise<string> {
  return (await captureExecutionInputs(dir, { declaredInputs: [] })).fingerprint;
}

async function satisfyingEvidence(id: string, criteriaIds: string[]): Promise<void> {
  const policy = (await import('../../src/core/board/rules.ts')).getPolicy(store, id)!;
  const run = beginEvidenceRun(store, {
    cardId: id,
    producer: 'suite',
    checkType: 'machine',
    checkId: 'tests',
    inputFingerprint: await fingerprint(),
    policyVersion: policy.version,
  });
  completeEvidenceRun(store, { runId: run.id, result: 'passed', criteria: criteriaIds });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-completion-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-completion-bin-'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\norigin.git/\n');
  git('init --bare origin.git -q');
  git('remote add origin ./origin.git');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m "c1"');
  git('push -q -u origin main');
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

describe('completion invariant', () => {
  test('missing evidence, policy or task progress each block completion', async () => {
    const id = groomed('blocked card', ['unfinished task']);
    enrollPolicy(store, id, { mode: 'solo' });
    const invariant = await completionInvariant(store, id);
    expect(invariant.satisfied).toBe(false);
    expect(invariant.blockers.some((blocker) => blocker.includes('unchecked task'))).toBe(true);
    await expect(recordCompletion(store, { cardId: id })).rejects.toThrow(CompletionBlockedError);

    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    const after = await completionInvariant(store, id);
    expect(after.satisfied).toBe(false);
    expect(after.blockers.some((blocker) => /criterion/.test(blocker))).toBe(true);
    await expect(recordCompletion(store, { cardId: id })).rejects.toThrow(CompletionBlockedError);
    expect(currentCompletion(store, id)).toBeNull();
  });

  test('no enrolled policy blocks completion on its own', async () => {
    const id = groomed('no policy card', ['task']);
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    const invariant = await completionInvariant(store, id);
    expect(invariant.blockers.some((blocker) => blocker.includes('no enrolled delivery/evidence policy'))).toBe(true);
  });

  test('stale source fingerprint makes prior evidence historical', async () => {
    const id = groomed('stale source card', ['task']);
    enrollPolicy(store, id, { mode: 'solo' });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    await satisfyingEvidence(id, scopeCriteria(store.db, id).filter((c) => c.state === 'active').map((c) => c.id));
    git('checkout -q -b card-branch');
    writeFileSync(join(dir, 'b.txt'), 'changed after evidence\n');
    git('add .');
    git('commit -q -m "later change"');
    const invariant = await completionInvariant(store, id);
    expect(invariant.satisfied).toBe(false);
    expect(invariant.blockers.some((blocker) => /stale|missing/.test(blocker))).toBe(true);
  });

  test('policy change makes prior evidence stale', async () => {
    const id = groomed('stale policy card', ['task']);
    enrollPolicy(store, id, { mode: 'solo' });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    const criteria = scopeCriteria(store.db, id).filter((c) => c.state === 'active').map((c) => c.id);
    await satisfyingEvidence(id, criteria);
    const { getPolicy } = await import('../../src/core/board/rules.ts');
    // A manual-criteria designation change re-enrolls the policy; prior
    // evidence runs recorded under the older policy version go stale.
    const criteriaIds = scopeCriteria(store.db, id).filter((c) => c.state === 'active').map((c) => c.id);
    enrollPolicy(store, id, { mode: 'solo', manualCriteria: criteriaIds });
    const invariant = await completionInvariant(store, id);
    expect(invariant.satisfied).toBe(false);
    expect(invariant.blockers.length).toBeGreaterThan(0);
  });

  test('current evidence satisfies the invariant and records one completion identity', async () => {
    const id = groomed('completable card', ['the only task']);
    enrollPolicy(store, id, { mode: 'solo' });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    const criteria = scopeCriteria(store.db, id).filter((c) => c.state === 'active').map((c) => c.id);
    await satisfyingEvidence(id, criteria);
    const invariant = await completionInvariant(store, id);
    expect(invariant.satisfied).toBe(true);
    expect(invariant.uncertainty).toContain('no approved impact snapshot — blast radius is not graph-backed');
    const record = await recordCompletion(store, { cardId: id, reviewState: 'cli-completion' });
    expect(record.acceptedRevision).toBe(1);
    expect(JSON.parse(record.evidenceSummary)).toHaveLength(criteria.length);
    // Idempotent: recording again returns the same identity, no duplicates.
    const again = await recordCompletion(store, { cardId: id });
    expect(again.id).toBe(record.id);
    expect(listCompletions(store, id)).toHaveLength(1);
    expect(currentCompletion(store, id)?.id).toBe(record.id);
  });

  test('scope change after completion invalidates current proof', async () => {
    const id = groomed('invalidate card', ['task']);
    enrollPolicy(store, id, { mode: 'solo' });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    await satisfyingEvidence(id, scopeCriteria(store.db, id).filter((c) => c.state === 'active').map((c) => c.id));
    const record = await recordCompletion(store, { cardId: id });
    applyScopeEdit(store.db, id, {
      operations: [{ kind: 'criterion', op: 'add', title: 'one more acceptance bar' }],
      actor: 'human',
    });
    expect(currentCompletion(store, id)).toBeNull();
    // The historical record remains readable.
    expect(listCompletions(store, id)[0]!.id).toBe(record.id);
  });

  test('clean verification holds for review/delivery; a checked checklist proves nothing alone', async () => {
    const id = groomed('hold card', ['the only task']);
    enrollPolicy(store, id, { mode: 'solo' });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    await satisfyingEvidence(id, scopeCriteria(store.db, id).filter((c) => c.state === 'active').map((c) => c.id));
    const { runVerification } = await import('../../src/core/engine/verify.ts');
    const { moveLane } = await import('../../src/core/board/lanes.ts');
    moveLane(store, id, 'verify', 'engine');
    const outcome = await runVerification(store, id);
    expect(outcome.result).toBe('clean');
    // Ordinary verbs hold in verify until finalization records the invariant.
    expect(store.getVerbItem(id).lane).toBe('verify');
    expect(currentCompletion(store, id)).toBeNull();
    // A checked checklist and verify lane without a completion route cannot
    // record completion proof.
    const bare = groomed('bare checked card', ['task']);
    store.syncTasks(bare, store.getVerbItem(bare).tasks.map((task) => ({ ...task, done: true })), 'engine');
    await expect(recordCompletion(store, { cardId: bare })).rejects.toThrow(CompletionBlockedError);
    expect(currentCompletion(store, bare)).toBeNull();
  });

  test('local completion records provenance without claiming provider delivery', async () => {
    const id = groomed('local provenance card', ['task']);
    enrollPolicy(store, id, { mode: 'solo' });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    await satisfyingEvidence(id, scopeCriteria(store.db, id).filter((c) => c.state === 'active').map((c) => c.id));
    const record = await recordCompletion(store, { cardId: id, deliveryId: 'dl-local-1', deliveryProvenance: 'local' });
    expect(record.deliveryProvenance).toBe('local');
    expect(record.deliveryId).toBe('dl-local-1');
  });

  test('archive tail retries reuse the completion identity without duplicating it', async () => {
    const id = groomed('tail retry card', ['task']);
    enrollPolicy(store, id, { mode: 'solo' });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    await satisfyingEvidence(id, scopeCriteria(store.db, id).filter((c) => c.state === 'active').map((c) => c.id));
    const first = await recordCompletion(store, { cardId: id, deliveryId: 'dl-1', deliveryProvenance: 'local' });
    const retried = await recordCompletion(store, { cardId: id, deliveryId: 'dl-1', deliveryProvenance: 'local' });
    expect(retried.id).toBe(first.id);
    expect(listCompletions(store, id)).toHaveLength(1);
  });
});

describe('finalization records completion', () => {
  test('solo finalize records the completion identity and marks done', async () => {
    stubGh();
    const { startVerb, archiveVerb } = await import('../../src/core/engine/verbs.ts');
    const { finalizeDelivery } = await import('../../src/core/engine/delivery.ts');
    const id = groomed('finalize card', ['finish everything']);
    await startVerb(store, id, 'feat');
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    enrollPolicy(store, id, { mode: 'solo' });
    await satisfyingEvidence(id, scopeCriteria(store.db, id).filter((c) => c.state === 'active').map((c) => c.id));
    await archiveVerb(store, id);
    const outcome = await finalizeDelivery(store, id);
    expect(outcome.result).toBe('delivered');
    const completion = currentCompletion(store, id);
    expect(completion).not.toBeNull();
    expect(completion!.deliveryProvenance).toBe('local');
    expect(store.getVerbItem(id).lane).toBe('done');
  });

  test('stale evidence refuses finalization before any completion is recorded', async () => {
    stubGh();
    const { startVerb, archiveVerb } = await import('../../src/core/engine/verbs.ts');
    const { finalizeDelivery } = await import('../../src/core/engine/delivery.ts');
    const id = groomed('refuse finalize card', ['finish everything']);
    await startVerb(store, id, 'feat');
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    enrollPolicy(store, id, { mode: 'solo' });
    await satisfyingEvidence(id, scopeCriteria(store.db, id).filter((c) => c.state === 'active').map((c) => c.id));
    await archiveVerb(store, id);
    // Evidence captured before preparation goes stale when sources move after it.
    git('checkout -q -b stale-branch');
    writeFileSync(join(dir, 'c.txt'), 'moved\n');
    git('add .');
    git('commit -q -m "post-evidence change"');
    await expect(finalizeDelivery(store, id)).rejects.toThrow();
    expect(currentCompletion(store, id)).toBeNull();
    expect(store.getVerbItem(id).lane).toBe('verify');
  });
});

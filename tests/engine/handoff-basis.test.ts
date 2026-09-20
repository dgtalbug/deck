// Handoff and task-progress basis: evidence movement under an offer refuses
// acceptance; task patches under a stale apply operation refuse.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { enrollPolicy, getPolicy } from '../../src/core/board/rules.ts';
import { applyScopeEdit } from '../../src/core/board/accepted-scope.ts';
import { acceptHandoff, offerHandoff } from '../../src/core/engine/handoffs';
import { assignTask, applyTaskPatch, getTaskAssignment } from '../../src/core/board/task-patches.ts';
import { beginEvidenceRun, completeEvidenceRun, startApply } from '../../src/core/engine/apply.ts';
import { captureExecutionInputs } from '../../src/core/engine/evidence-inputs.ts';

let dir: string;
let store: DocumentStore;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function firstTaskId(id: string): string {
  return store.getVerbItem(id).tasks[0]!.id;
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
  dir = mkdtempSync(join(tmpdir(), 'deck-handoff-basis-'));
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

describe('handoff basis', () => {
  test('accepting a current basis transfers responsibility once', () => {
    const id = groomed('handoff current card', ['the task']);
    assignTask(store, { cardId: id, taskId: firstTaskId(id), owner: 'alice', by: 'alice' });
    const offer = offerHandoff(store, { cardId: id, taskId: firstTaskId(id), sender: 'alice', recipient: 'bob' });
    const accepted = acceptHandoff(store, { handoffId: offer.id, recipient: 'bob' });
    expect(accepted.state).toBe('accepted');
    // Idempotent re-acceptance returns the same transfer.
    const again = acceptHandoff(store, { handoffId: offer.id, recipient: 'bob' });
    expect(again.state).toBe('accepted');
  });

  test('evidence recorded after the offer refuses acceptance until re-offer', async () => {
    const id = groomed('handoff evidence card', ['the task']);
    enrollPolicy(store, id, { mode: 'solo' });
    assignTask(store, { cardId: id, taskId: firstTaskId(id), owner: 'alice', by: 'alice' });
    const offer = offerHandoff(store, { cardId: id, taskId: firstTaskId(id), sender: 'alice', recipient: 'bob' });
    const fingerprint = (await captureExecutionInputs(dir, { declaredInputs: [] })).fingerprint;
    const run = beginEvidenceRun(store, {
      cardId: id,
      producer: 'suite',
      checkType: 'machine',
      inputFingerprint: fingerprint,
      policyVersion: getPolicy(store, id)!.version,
    });
    completeEvidenceRun(store, { runId: run.id, result: 'passed' });
    expect(() => acceptHandoff(store, { handoffId: offer.id, recipient: 'bob' })).toThrow(/evidence state changed since the offer/);
  });

  test('scope change after the offer refuses acceptance (existing fence preserved)', () => {
    const id = groomed('handoff scope card', ['the task']);
    assignTask(store, { cardId: id, taskId: firstTaskId(id), owner: 'alice', by: 'alice' });
    const offer = offerHandoff(store, { cardId: id, taskId: firstTaskId(id), sender: 'alice', recipient: 'bob' });
    applyScopeEdit(store.db, id, {
      operations: [{ kind: 'criterion', op: 'add', title: 'a new acceptance bar' }],
      actor: 'human',
    });
    expect(() => acceptHandoff(store, { handoffId: offer.id, recipient: 'bob' })).toThrow(/scope changed since the offer/);
  });
});

describe('task patches under a controlled apply', () => {
  test('patch under a current apply basis applies; stale basis refuses without changes', async () => {
    const id = groomed('patch basis card', ['the task']);
    assignTask(store, { cardId: id, taskId: firstTaskId(id), owner: 'alice', by: 'alice' });
    await startApply(store, id);
    const applied = applyTaskPatch(store, {
      cardId: id,
      taskId: firstTaskId(id),
      owner: 'alice',
      done: true,
      expectedRevision: getTaskAssignment(store, id, firstTaskId(id)).revision,
      commandId: 'cmd-1',
    });
    expect(applied.done).toBe(true);
    applyScopeEdit(store.db, id, {
      operations: [{ kind: 'criterion', op: 'add', title: 'scope moved' }],
      actor: 'human',
    });
    expect(() => applyTaskPatch(store, {
      cardId: id,
      taskId: firstTaskId(id),
      owner: 'alice',
      done: false,
      expectedRevision: getTaskAssignment(store, id, firstTaskId(id)).revision,
      commandId: 'cmd-2',
    })).toThrow(/apply basis of .* is stale/);
    // Refusal changed nothing.
    expect(store.getVerbItem(id).tasks.find((task) => task.id === firstTaskId(id))!.done).toBe(true);
  });
});

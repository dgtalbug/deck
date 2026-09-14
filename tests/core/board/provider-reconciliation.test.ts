import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { publishSpec } from '../../../src/core/board/publish.ts';
import { startVerb } from '../../../src/core/engine/verbs.ts';
import { getIssueMap } from '../../../src/core/board/specstore.ts';
import {
  claimIntent,
  completeIntent,
  failIntent,
  getOperation,
  listCardOperations,
  markUncertain,
  ProviderClaimError,
  reconcileOperation,
  recordIntent,
  type RemoteMatch,
} from '../../../src/core/board/provider-operations.ts';
import type { ProviderRunner, IssueRef } from '../../../src/core/git/issues.ts';
import { GitOpError } from '../../../src/core/git/errors.ts';

// Task 3.5 (+ 3.2/3.3/3.7 pieces) — provider intent reconciliation under a
// fake provider: delayed visibility, multiple matches, conclusive failure,
// identity mismatch, crash-after-success, claim fencing, and start
// compensation preserving remote intent.
let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

// A gh stub whose `issue list --search` output is scriptable per test.
let searchResult = '[]';
let createCalls = 0;

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") create_calls=$((create_calls+1)); echo "https://github.com/o/r/issues/7" ;;
  "issue list") echo "\${SEARCH_JSON:-[]}" ;;
  "issue view") echo "{\\"number\\":7,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function fakeRunner(matches: IssueRef[], opts: { fail?: boolean } = {}): ProviderRunner {
  return {
    async run(args) {
      if (opts.fail) return { code: 1, stdout: '', stderr: 'provider exploded' };
      if (args[0] === 'issue' && args[1] === 'list') {
        return { code: 0, stdout: JSON.stringify(matches), stderr: '' };
      }
      return { code: 0, stdout: '[]', stderr: '' };
    },
  };
}

function groomed(title: string): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: [],
    openQuestions: [],
  });
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-reconcile-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-reconcile-bin-'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m c1');
  stubGh();
  store = await openStore(dir);
  createCalls = 0;
  searchResult = '[]';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
});

describe('provider intent reconciliation', () => {
  test('crash after create success: restart reconciles the original resource, no second create', async () => {
    const id = groomed('crash survivor card');
    const intent = recordIntent(store, {
      cardId: id,
      kind: 'issue-create',
      repo: 'o/r',
      projectId: 'p1',
      marker: 'deck:p1:crash',
      payload: { title: 'feat: crash survivor card' },
    });
    claimIntent(store, intent.id, 'worker-a');
    // Simulated crash: the create succeeded remotely but nothing was saved —
    // the operation is stranded 'claimed'. Restart reconciles by marker.
    const matches: IssueRef[] = [{ number: 7, title: 'feat: crash survivor card', state: 'open', url: 'u/7' }];
    const fake = fakeRunner(matches);
    const matchesFound = await fake.run(['issue', 'list', '--search', intent.marker]);
    const row = reconcileOperation(
      store,
      intent.id,
      (JSON.parse(matchesFound!.stdout) as IssueRef[]).map((issue) => ({
        remoteId: String(issue.number),
        remoteUrl: issue.url,
      })),
    );
    expect(row.state).toBe('reconciled');
    expect(row.remoteId).toBe('7');
    // publishSpec now maps the recovered issue instead of creating another.
    const outcome = await publishSpec(store, id);
    expect(outcome.issueNumber).toBe(7);
    expect(outcome.queued).toBe(false);
    expect(getIssueMap(store, id)?.issueNumber).toBe(7);
  });

  test('delayed visibility: zero matches stays uncertain and refuses a replacement create', async () => {
    const id = groomed('delayed visibility card');
    const intent = recordIntent(store, {
      cardId: id,
      kind: 'issue-create',
      repo: 'o/r',
      projectId: 'p1',
      marker: 'deck:p1:delayed',
      payload: { title: 'feat: delayed visibility card' },
    });
    claimIntent(store, intent.id, 'worker-a');
    markUncertain(store, intent.id, 'worker-a', 'connection reset after dispatch');
    // The provider currently shows nothing — that is NOT proof of absence.
    const row = reconcileOperation(store, intent.id, [] as RemoteMatch[]);
    expect(row.state).toBe('uncertain');
    expect(row.nextAction).toContain('no replacement create');
    // publishSpec refuses instead of creating a duplicate.
    searchResult = '[]';
    await expect(publishSpec(store, id)).rejects.toThrow(GitOpError);
  });

  test('multiple matches conflict and never auto-pick', async () => {
    const id = groomed('conflicted card');
    const intent = recordIntent(store, {
      cardId: id,
      kind: 'issue-create',
      repo: 'o/r',
      projectId: 'p1',
      marker: 'deck:p1:conflict',
      payload: { title: 'feat: conflicted card' },
    });
    claimIntent(store, intent.id, 'worker-a');
    const row = reconcileOperation(store, intent.id, [
      { remoteId: '11', remoteUrl: 'u/11' },
      { remoteId: '12', remoteUrl: 'u/12' },
    ]);
    expect(row.state).toBe('conflicted');
    expect(row.error).toContain('2 remote resources');
  });

  test('conclusive provider failure records actionable error; retry takes a fresh revision', async () => {
    const id = groomed('permanent failure card');
    const intent = recordIntent(store, {
      cardId: id,
      kind: 'issue-create',
      repo: 'o/r',
      projectId: 'p1',
      marker: 'deck:p1:permfail',
      payload: { title: 'feat: permanent failure card' },
    });
    claimIntent(store, intent.id, 'worker-a');
    const failed = failIntent(store, intent.id, 'worker-a', '422 validation failed', 'fix the payload, then publish again');
    expect(failed.state).toBe('failed');
    expect(failed.error).toContain('422');
    expect(failed.nextAction).toContain('publish again');
    // A later retry records a NEW revision — the failed one stays history.
    const retry = recordIntent(store, {
      cardId: id,
      kind: 'issue-create',
      repo: 'o/r',
      projectId: 'p1',
      marker: 'deck:p1:permfail',
      payload: { title: 'feat: permanent failure card' },
    });
    expect(retry.id).not.toBe(intent.id);
    expect(retry.payloadRevision).toBe(intent.payloadRevision + 1);
  });

  test('legacy mapping read-back reconciles despite remote rename (content identity wins)', async () => {
    const id = groomed('legacy readback card');
    // The migration wrote a legacy-unobserved row at open for mapped cards;
    // simulate one directly for an unmapped card.
    const intent = recordIntent(store, {
      cardId: id,
      kind: 'issue-create',
      repo: 'o/old-name',
      projectId: 'p1',
      marker: 'deck:p1:legacy',
      payload: { legacy: true },
    });
    claimIntent(store, intent.id, 'legacy');
    markUncertain(store, intent.id, 'legacy');
    // The repository was renamed — the marker (content, not path) still finds it.
    const row = reconcileOperation(store, intent.id, [{ remoteId: '42', remoteUrl: 'https://github.com/o/renamed/issues/42' }]);
    expect(row.state).toBe('reconciled');
    expect(row.remoteId).toBe('42');
  });

  test('claim fencing: a second worker cannot claim an owned intent', () => {
    const id = groomed('fencing card');
    const intent = recordIntent(store, {
      cardId: id,
      kind: 'issue-create',
      repo: 'o/r',
      projectId: 'p1',
      marker: 'deck:p1:fence',
      payload: { title: 'x' },
    });
    claimIntent(store, intent.id, 'worker-a');
    expect(() => claimIntent(store, intent.id, 'worker-b')).toThrow(ProviderClaimError);
    completeIntent(store, intent.id, 'worker-a', '9', 'u/9');
    expect(getOperation(store, intent.id)?.state).toBe('succeeded');
  });

  test('two-handle flush race: the losing create handle queues instead of double-creating', async () => {
    const id = groomed('flush race card');
    // Handle A: records intent and claims it (about to dispatch).
    const intent = recordIntent(store, {
      cardId: id,
      kind: 'issue-create',
      repo: 'o/r',
      projectId: 'p1',
      marker: 'deck:p1:race',
      payload: { title: 'feat: flush race card' },
    });
    claimIntent(store, intent.id, 'worker-a');
    // Handle B: publishSpec sees no map, tries to create — the claim fence
    // makes it queue instead of issuing a second network create.
    const outcome = await publishSpec(store, id);
    expect(outcome.queued).toBe(true);
    expect(outcome.issueNumber).toBeNull();
    // Only A's intent exists for the card.
    expect(listCardOperations(store, id)).toHaveLength(1);
    expect(getOperation(store, intent.id)?.state).toBe('claimed');
  });
});

describe('start compensation preserves provider intent (3.7)', () => {
  test('branch failure deletes the map row but the succeeded intent survives', async () => {
    const id = groomed('compensate intent card');
    git(`branch feat/compensate-intent-card`);
    await expect(startVerb(store, id, 'feat')).rejects.toThrow();
    expect(getIssueMap(store, id)).toBeUndefined();
    // The ledger keeps the remote truth: the issue was created and stays.
    const ops = listCardOperations(store, id).filter((op) => op.kind === 'issue-create');
    expect(ops).toHaveLength(1);
    expect(ops[0]!.state).toBe('succeeded');
    expect(ops[0]!.remoteId).toBe('7');
  });
});

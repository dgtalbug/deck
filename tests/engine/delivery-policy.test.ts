// Task 4.6 — team observation and policy evaluation (DECK-ARCH-014): pending
// and failed checks, missing approval, closed-unmerged, unknown provider
// observation, head drift and accepted merge variants — including squash
// merges where merge SHA ≠ head SHA — evaluated against one fetched
// observation and through the finalization door.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveLane } from '../../src/core/board/lanes.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { enrollPolicy } from '../../src/core/board/rules.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import { archiveVerb } from '../../src/core/engine/archive.ts';
import { evaluateTeamObservation, finalizeDelivery, newestDelivery } from '../../src/core/engine/delivery.ts';
import type { PullRequestObservation } from '../../src/core/git/ops.ts';
import type { DeliveryRow } from '../../src/core/board/schema.ts';

let dir: string;
let origin: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;
// Scriptable `pr view` payload; written to a file the stub cats.
let prView: Record<string, unknown>;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/91" ;;
  "issue view") echo '{"number":91,"state":"OPEN","labels":[],"url":"u"}' ;;
  "pr create") echo "https://github.com/o/r/pull/92" ;;
  "pr list") echo '[]' ;;
  "pr view") cat ${JSON.stringify(join(dir, 'pr-view.json'))} ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function writePrView(): void {
  writeFileSync(join(dir, 'pr-view.json'), JSON.stringify(prView));
}

async function preparedCard(title: string, requiredApprovals = 1): Promise<string> {
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
  await publishSpec(store, note.id);
  moveLane(store, note.id, 'active', 'engine');
  moveLane(store, note.id, 'verify', 'engine');
  enrollPolicy(store, note.id, { mode: 'team', requiredApprovals });
  git(`checkout -q -b feat/${title.replace(/[^a-z0-9]+/gi, '-')}`);
  writeFileSync(join(dir, 'work.txt'), `${title}\n`);
  git('add work.txt');
  git('commit -q -m "feat: policy work"');
  const outcome = await archiveVerb(store, note.id);
  expect(outcome.delivery.state).toBe('pending');
  return note.id;
}

function delivery(): DeliveryRow {
  const card = store.db.all<{ card_id: string }>('SELECT card_id FROM deliveries');
  const id = card.at(-1)!.card_id;
  return newestDelivery(store, id)!;
}

function obs(overrides: Partial<PullRequestObservation> = {}): PullRequestObservation {
  return {
    number: 92,
    title: 'pr',
    url: 'https://github.com/o/r/pull/92',
    state: 'merged',
    headRefName: 'feat/x',
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    mergeCommit: { oid: 'b'.repeat(40) },
    checks: [{ name: 'unit-tests', state: 'success' }],
    reviewDecision: 'approved',
    ...overrides,
  };
}

function teamDelivery(): DeliveryRow {
  return {
    id: 'dl-pure-1',
    cardId: 'c1',
    attempt: 1,
    mode: 'team',
    policyVersion: 1,
    scopeRevision: 1,
    inputFingerprint: null,
    prNumber: 92,
    prUrl: 'u',
    headSha: 'a'.repeat(40),
    baseBranch: 'main',
    mergeSha: null,
    mergeMethod: null,
    deliveredSha: null,
    provenance: null,
    state: 'pending',
    refusalReason: null,
    createdAt: '',
    updatedAt: '',
  };
}

const POLICY = { requiredChecks: ['unit-tests'], requiredApprovals: 1 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-delivery-policy-'));
  origin = mkdtempSync(join(tmpdir(), 'deck-delivery-policy-origin-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-delivery-policy-bin-'));
  stubGh();
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  execSync(`git init --bare -q ${JSON.stringify(origin)}`, { stdio: 'ignore' });
  git(`remote add origin ${JSON.stringify(origin)}`);
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\ndeck.rules.yaml\npr-view.json\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m c1');
});

afterEach(async () => {
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

describe('team observation policy (pure evaluation)', () => {
  test('a pending required check blocks', () => {
    const check = evaluateTeamObservation('c1', teamDelivery(), POLICY, obs({ checks: [{ name: 'unit-tests', state: 'pending' }] }));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/pending/);
  });

  test('a failed required check blocks', () => {
    const check = evaluateTeamObservation('c1', teamDelivery(), POLICY, obs({ checks: [{ name: 'unit-tests', state: 'failure' }] }));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/failed/);
  });

  test('an unreported required check blocks', () => {
    const check = evaluateTeamObservation('c1', teamDelivery(), POLICY, obs({ checks: [] }));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/not reported/);
  });

  test('a missing approval blocks when the policy requires one', () => {
    const check = evaluateTeamObservation('c1', teamDelivery(), POLICY, obs({ reviewDecision: 'review_required' }));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/approvals/);
  });

  test('a closed-unmerged PR blocks', () => {
    const check = evaluateTeamObservation('c1', teamDelivery(), POLICY, obs({ state: 'closed', mergeCommit: null }));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/closed without merge/);
  });

  test('an open-but-valid PR is awaiting merge, not deliverable', () => {
    const check = evaluateTeamObservation('c1', teamDelivery(), POLICY, obs({ state: 'open', mergeCommit: null }));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/not merged yet/);
  });

  test('head drift blocks', () => {
    const check = evaluateTeamObservation('c1', teamDelivery(), POLICY, obs({ headRefOid: 'c'.repeat(40) }));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/head drift/);
  });

  test('a wrong base blocks', () => {
    const check = evaluateTeamObservation('c1', teamDelivery(), POLICY, obs({ baseRefName: 'develop' }));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/PR base/);
  });

  test('a merged PR without provider merge attribution fails closed', () => {
    const check = evaluateTeamObservation('c1', teamDelivery(), POLICY, obs({ mergeCommit: null }));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/did not attribute a merge commit/);
  });

  test('a valid squash merge (merge SHA ≠ head SHA) is accepted', () => {
    const check = evaluateTeamObservation('c1', teamDelivery(), POLICY, obs());
    expect(check.ok).toBe(true);
    expect(check.reason).toBeNull();
  });

  test('a valid merge-merge commit variant is accepted too', () => {
    const check = evaluateTeamObservation('c1', teamDelivery(), POLICY, obs({ mergeCommit: { oid: 'd'.repeat(40) } }));
    expect(check.ok).toBe(true);
  });
});

describe('team observation policy (finalization door)', () => {
  test('unknown provider state: unparseable observation fails closed', async () => {
    store = await openStore(dir);
    const id = await preparedCard('final unknown state card');
    prView = { nonsense: true };
    writePrView();
    await expect(finalizeDelivery(store, id)).rejects.toThrow();
    expect(store.getVerbItem(id).lane).toBe('verify'); // nothing completed
  });

  test('an unsatisfied observation refuses finalization and marks the delivery', async () => {
    store = await openStore(dir);
    const id = await preparedCard('final refused card');
    const row = delivery();
    prView = {
      number: 92,
      title: 'pr',
      url: 'u',
      state: 'OPEN',
      headRefName: 'x',
      headRefOid: row.headSha,
      baseRefName: 'main',
      mergeCommit: null,
      statusCheckRollup: [],
      reviewDecision: null,
    };
    writePrView();
    const outcome = await finalizeDelivery(store, id);
    expect(outcome.result).toBe('refused');
    expect(outcome.reason).toMatch(/unit-tests|approvals/);
    expect(outcome.card.lane).toBe('verify');
    expect(newestDelivery(store, id)!.state).toBe('refused');
  });

  test('a valid open PR with passing checks awaits merge — delivery stays pending', async () => {
    store = await openStore(dir);
    const id = await preparedCard('final awaiting card', 0);
    const row = delivery();
    prView = {
      number: 92,
      title: 'pr',
      url: 'https://github.com/o/r/pull/92',
      state: 'OPEN',
      headRefName: 'x',
      headRefOid: row.headSha,
      baseRefName: 'main',
      mergeCommit: null,
      statusCheckRollup: [],
      reviewDecision: null,
    };
    writePrView();
    const outcome = await finalizeDelivery(store, id);
    expect(outcome.result).toBe('awaiting-merge');
    expect(outcome.reason).toMatch(/not merged yet/);
    expect(outcome.card.lane).toBe('verify');
    expect(newestDelivery(store, id)!.state).toBe('pending');
  });

  test('a valid observed squash merge completes the card', async () => {
    store = await openStore(dir);
    const id = await preparedCard('final delivered card', 0);
    const row = delivery();
    prView = {
      number: 92,
      title: 'pr',
      url: 'https://github.com/o/r/pull/92',
      state: 'MERGED',
      headRefName: 'x',
      headRefOid: row.headSha,
      baseRefName: 'main',
      mergeCommit: { oid: 'e'.repeat(40) },
      statusCheckRollup: [],
      reviewDecision: 'APPROVED',
    };
    writePrView();
    const outcome = await finalizeDelivery(store, id);
    expect(outcome.result).toBe('delivered');
    expect(outcome.card.lane).toBe('done');
    const delivered = newestDelivery(store, id)!;
    expect(delivered.state).toBe('delivered');
    expect(delivered.mergeSha).toBe('e'.repeat(40)); // squash: ≠ headSha
    expect(delivered.provenance).toBe('hosted');
  });
});

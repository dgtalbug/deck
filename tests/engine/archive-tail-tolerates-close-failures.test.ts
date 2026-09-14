import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { archiveVerb, startVerb } from '../../src/core/engine/verbs.ts';
import { finalizeDelivery } from '../../src/core/engine/delivery.ts';
import { retryCleanup } from '../../src/core/engine/delivery-cleanup.ts';
import { enrollPolicy } from '../../src/core/board/rules.ts';
import { deliveryStatus } from '../../src/core/engine/delivery.ts';

// Requirement (E05): archive tail tolerates close failures — after the card
// is DELIVERED, a failing issue close (or branch delete) leaves the delivery
// recorded and the cleanup step inspectable and retryable. Cleanup never
// re-merges and never undoes done.
let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function stubGh(script: string): void {
  writeFileSync(join(binDir, 'gh'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

const GH_OK = `case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/41" ;;
  "issue edit") echo ok ;;
  "issue view") echo "{\\"number\\":41,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  "issue close") echo closed ;;
  "pr create") echo "https://github.com/o/r/pull/51" ;;
  "pr list") echo "[]" ;;
  "pr view") cat "$PR_JSON" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac`;

// Everything works EXCEPT closing the issue.
const GH_CLOSE_FAILS = `case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/41" ;;
  "issue edit") echo ok ;;
  "issue view") echo "{\\"number\\":41,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  "issue close") echo "gh: network gone" >&2; exit 1 ;;
  "pr create") echo "https://github.com/o/r/pull/51" ;;
  "pr list") echo "[]" ;;
  "pr view") cat "$PR_JSON" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac`;

function groomed(title: string): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['implement', 'verify'],
    openQuestions: [],
  });
  return note.id;
}

async function preparedCard(title: string): Promise<string> {
  const id = groomed(title);
  await startVerb(store, id, 'feat');
  enrollPolicy(store, id, { mode: 'team' });
  store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
  writeFileSync(join(dir, 'change.txt'), 'the change\n');
  git('add .');
  git('commit -m "feat: the change"');
  await archiveVerb(store, id); // prepare: PR open, delivery pending
  // Observe a valid merged PR bound to the prepared head (fake provider).
  const status = deliveryStatus(store, id);
  const delivery = status.delivery!;
  process.env['PR_JSON'] = join(binDir, 'pr.json');
  writeFileSync(
    join(binDir, 'pr.json'),
    JSON.stringify({
      number: delivery.prNumber,
      title: 't',
      url: 'https://github.com/o/r/pull/51',
      state: 'MERGED',
      headRefName: 'head',
      headRefOid: delivery.headSha,
      baseRefName: delivery.baseBranch,
      mergeCommit: { oid: 'mergeoid1234567890' },
      statusCheckRollup: [],
      reviewDecision: null,
    }),
  );
  return id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-archive-tail-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-archive-tail-bin-'));
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\norigin.git/\n');
  git('init --bare origin.git');
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

describe('delivery cleanup close-failure tolerance', () => {
  test('issue close failing after the observed merge stays inspectable and retryable', async () => {
    stubGh(GH_CLOSE_FAILS);
    const id = await preparedCard('tolerant delivery');

    // Merge was never local — deck did not touch main; the card IS delivered.
    const finalized = await finalizeDelivery(store, id);
    expect(finalized.result).toBe('delivered');
    expect(finalized.card.lane).toBe('done');
    expect(finalized.delivery.deliveredSha).toBe('mergeoid1234567890');
    expect(git('rev-parse --abbrev-ref HEAD').trim()).not.toBe('');

    // Cleanup: the issue close fails but the delivery stays done.
    const outcome = await retryCleanup(store, id);
    expect(outcome.results.find((step) => step.kind === 'issue-close')?.state).toBe('failed');
    const status = deliveryStatus(store, id);
    expect(status.delivery!.state).toBe('delivered');
    expect(store.getVerbItem(id).lane).toBe('done');

    // Retry with gh healthy: only the unfinished follow-up runs, done again.
    stubGh(GH_OK);
    const retried = await retryCleanup(store, id);
    expect(retried.results.find((step) => step.kind === 'issue-close')?.state).toBe('done');
    expect(store.getVerbItem(id).lane).toBe('done');
  });

  test('with gh healthy cleanup closes silently', async () => {
    stubGh(GH_OK);
    const id = await preparedCard('clean delivery');
    const finalized = await finalizeDelivery(store, id);
    expect(finalized.result).toBe('delivered');
    const outcome = await retryCleanup(store, id);
    expect(outcome.results.find((step) => step.kind === 'issue-close')?.state).toBe('done');
    expect(store.getVerbItem(id).lane).toBe('done');
  });
});

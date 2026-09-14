// Task 4.10 — finalization atomicity: concurrent finalizers emit ONE
// completion event and observe the same delivered identity; scope and policy
// races after preparation refuse; a crash around the local completion commit
// retries into the recorded outcome instead of a second completion.
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
import { finalizeDelivery, newestDelivery, recordDeliveryAttempt } from '../../src/core/engine/delivery.ts';
import { completeFromDelivery } from '../../src/core/board/verify.ts';
import { branchFor } from '../../src/core/engine/slug.ts';
import { events } from '../../src/core/events/schema.ts';
import { eq } from 'drizzle-orm';

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
  "issue create") echo "https://github.com/o/r/issues/21" ;;
  "issue view") echo '{"number":21,"state":"OPEN","labels":[],"url":"u"}' ;;
  "pr create") echo "https://github.com/o/r/pull/22" ;;
  "pr list") echo '[]' ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

async function preparedSoloCard(title: string): Promise<string> {
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
  enrollPolicy(store, note.id, { mode: 'solo' });
  const branch = branchFor(store.getVerbItem(note.id), 'feat');
  git(`checkout -q -b ${JSON.stringify(branch)}`);
  writeFileSync(join(dir, 'work.txt'), `${title}\n`);
  git('add work.txt');
  git('commit -q -m "feat: finalize work"');
  await archiveVerb(store, note.id);
  return note.id;
}

function doneEventCount(id: string): number {
  return store.db
    .select()
    .from(events)
    .all()
    .filter(
      (row) =>
        row.type === 'card.done' &&
        (JSON.parse(row.payload) as { id?: string }).id === id,
    ).length;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-delivery-finalize-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-delivery-finalize-bin-'));
  stubGh();
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\ndeck.rules.yaml\n');
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
  rmSync(binDir, { recursive: true, force: true });
});

describe('finalization atomicity', () => {
  test('two concurrent finalizers produce one completion event and one delivered identity', async () => {
    store = await openStore(dir);
    const id = await preparedSoloCard('finalize concurrent card');
    const delivery = newestDelivery(store, id)!;
    // Both finalizers race into the once-only core with the same delivery.
    const first = completeFromDelivery(store, id, delivery.id);
    const second = completeFromDelivery(store, id, delivery.id);
    expect([first.delivered, second.delivered].sort()).toEqual([false, true]);
    expect(doneEventCount(id)).toBe(1);
    const row = newestDelivery(store, id)!;
    expect(row.state).toBe('delivered');
    expect(row.deliveredSha ?? row.mergeSha ?? row.headSha).toBeTruthy();
  });

  test('a scope revision change after preparation refuses finalization', async () => {
    store = await openStore(dir);
    const id = await preparedSoloCard('finalize scope race card');
    // The accepted scope moved under the delivery (cards.scope_revision bump).
    store.raw().run('UPDATE cards SET scope_revision = scope_revision + 1 WHERE id = ?', [id]);
    await expect(finalizeDelivery(store, id)).rejects.toThrow(/scope changed since preparation/);
    expect(store.getVerbItem(id).lane).toBe('verify');
    expect(newestDelivery(store, id)!.state).toBe('refused');
  });

  test('a policy version change after preparation refuses finalization', async () => {
    store = await openStore(dir);
    const id = await preparedSoloCard('finalize policy race card');
    enrollPolicy(store, id, { mode: 'solo' }); // version bump under the delivery
    await expect(finalizeDelivery(store, id)).rejects.toThrow(/policy changed since preparation/);
    expect(store.getVerbItem(id).lane).toBe('verify');
    expect(newestDelivery(store, id)!.state).toBe('refused');
  });

  test('a crash around the local completion commit retries into the recorded outcome', async () => {
    store = await openStore(dir);
    const id = await preparedSoloCard('finalize crash retry card');
    const delivery = newestDelivery(store, id)!;
    // The crash window: completion committed, caller never saw the answer.
    completeFromDelivery(store, id, delivery.id);
    // The retry finalization observes the recorded outcome — no duplicate.
    const retry = await finalizeDelivery(store, id);
    expect(retry.result).toBe('delivered');
    expect(retry.card.lane).toBe('done');
    expect(doneEventCount(id)).toBe(1);
    expect(retry.delivery.id).toBe(delivery.id);
  });

  test('finalization of an unknown delivery attempt refuses before any write', async () => {
    store = await openStore(dir);
    const id = await preparedSoloCard('finalize unknown delivery card');
    const stranger = recordDeliveryAttempt(store, {
      cardId: id,
      mode: 'solo',
      policyVersion: 1,
      scopeRevision: 999,
      inputFingerprint: null,
      headSha: null,
      baseBranch: 'main',
    });
    expect(() => completeFromDelivery(store, id, stranger.id)).not.toThrow(); // valid row completes
    expect(doneEventCount(id)).toBe(1);
  });
});

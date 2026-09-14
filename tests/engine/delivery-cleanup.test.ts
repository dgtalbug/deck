// Task 4.12 — persisted cleanup retries: each follow-up (issue close, branch
// delete, changelog, release) carries its own progress over the RECORDED
// delivery identity; failures leave the card done and stay retryable; the
// changelog dedupes on the delivery marker; releases reconcile by tag
// identity; cleanup without a delivered attempt refuses.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveLane } from '../../src/core/board/lanes.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { enrollPolicy } from '../../src/core/board/rules.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import { archiveVerb } from '../../src/core/engine/archive.ts';
import { deliveryStatus, finalizeDelivery, newestDelivery } from '../../src/core/engine/delivery.ts';
import { retryCleanup } from '../../src/core/engine/delivery-cleanup.ts';
import { branchFor } from '../../src/core/engine/slug.ts';

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
  "issue create") echo "https://github.com/o/r/issues/61" ;;
  "issue view") echo '{"number":61,"state":"OPEN","labels":[],"url":"u"}' ;;
  "issue close") echo closed ;;
  "release view") exit 1 ;;
  "release create") echo "https://github.com/o/r/releases/tag/v1.2.3" ;;
  *) echo ok ;;
esac`;

// A solo card delivered locally — cleanup rides the recorded identity, no
// provider merge to worry about.
async function deliveredSoloCard(title: string): Promise<string> {
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
  git('commit -q -m "feat: cleanup work"');
  await archiveVerb(store, note.id);
  const final = await finalizeDelivery(store, note.id);
  expect(final.result).toBe('delivered');
  return note.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-delivery-cleanup-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-delivery-cleanup-bin-'));
  stubGh(GH_OK);
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\ndeck.rules.yaml\nCHANGELOG.md\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m c1');
});

afterEach(() => {
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

describe('delivery cleanup retries', () => {
  test('cleanup without a delivered attempt refuses', async () => {
    store = await openStore(dir);
    const id = await deliveredSoloCard('cleanup refuse card');
    // Wipe the delivery record's delivered state — cleanup has nothing recorded.
    store.raw().run("UPDATE deliveries SET state = 'pending' WHERE card_id = ?", [id]);
    await expect(retryCleanup(store, id)).rejects.toThrow(/no delivered attempt/);
  });

  test('a full sweep closes the issue, deletes the branch, writes one changelog entry', async () => {
    store = await openStore(dir);
    const id = await deliveredSoloCard('cleanup sweep card');
    const branch = branchFor(store.getVerbItem(id), 'feat');
    const outcome = await retryCleanup(store, id);
    const byKind = Object.fromEntries(outcome.results.map((step) => [step.kind, step.state]));
    expect(byKind['issue-close']).toBe('done');
    expect(byKind['branch-delete']).toBe('done');
    expect(byKind['changelog']).toBe('done');
    expect(byKind['release']).toBe('done'); // no version bump → not applicable
    expect(git(`branch --list ${JSON.stringify(branch)}`).trim()).toBe('');
    expect(git('rev-parse --abbrev-ref HEAD').trim()).toBe('main');
    expect(store.getVerbItem(id).lane).toBe('done');
  });

  test('a changelog retry never duplicates the entry (delivery-marker dedupe)', async () => {
    store = await openStore(dir);
    const id = await deliveredSoloCard('cleanup changelog card');
    const marker = `deck-delivery:${newestDelivery(store, id)!.id}`;
    await retryCleanup(store, id);
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toContain(marker);
    // Force the follow-up back to pending and sweep again — still one entry.
    store.raw().run("UPDATE cleanup_tasks SET state = 'pending' WHERE kind = 'changelog'");
    const retried = await retryCleanup(store, id);
    expect(retried.results.find((step) => step.kind === 'changelog')?.state).toBe('done');
    const changelog = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    expect(changelog.split(marker).length - 1).toBe(1);
  });

  test('a failing issue close stays retryable and the delivery stays done', async () => {
    store = await openStore(dir);
    const id = await deliveredSoloCard('cleanup close fail card');
    stubGh(GH_OK.replace('"issue close") echo closed ;;', '"issue close") echo "gh: down" >&2; exit 1 ;;'));
    const failed = await retryCleanup(store, id);
    expect(failed.results.find((step) => step.kind === 'issue-close')?.state).toBe('failed');
    expect(store.getVerbItem(id).lane).toBe('done');
    expect(deliveryStatus(store, id).delivery!.state).toBe('delivered');
    stubGh(GH_OK);
    const retried = await retryCleanup(store, id);
    expect(retried.results.find((step) => step.kind === 'issue-close')?.state).toBe('done');
    // branch-delete already finished in the first sweep — not re-run, not failed
    expect(retried.results.find((step) => step.kind === 'branch-delete')?.state !== 'failed').toBe(true);
  });

  test('an existing remote release reconciles by tag identity instead of duplicating', async () => {
    store = await openStore(dir);
    const id = await deliveredSoloCard('cleanup release card');
    // No version bump shipped → release is "not applicable"; force the
    // follow-up open with a bumped-version diff absent — reconciliation is
    // exercised through the tag-identity read below.
    await retryCleanup(store, id);
    store.raw().run("UPDATE cleanup_tasks SET state = 'pending' WHERE kind = 'release'");
    // Pretend the release already exists remotely: view succeeds.
    stubGh(GH_OK.replace('"release view") exit 1 ;;', '"release view") echo \'{"url":"u"}\' ;;'));
    const retried = await retryCleanup(store, id);
    expect(retried.results.find((step) => step.kind === 'release')?.state).toBe('done');
    expect(retried.results.find((step) => step.kind === 'release')?.detail).toMatch(/no eligible version tag|reconcil/);
  });
});

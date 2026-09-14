// Task 4.8 — explicit solo/local delivery: guarded local integration
// (clean tree, owned checkout, no provider), a conflict aborts and restores
// the base, a wrong checkout refuses, and the completion record claims LOCAL
// provenance only — never hosted review/push/merge assurance.
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
import { finalizeDelivery, newestDelivery } from '../../src/core/engine/delivery.ts';
import { branchFor } from '../../src/core/engine/slug.ts';

let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function stubGh(logPath: string): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(logPath)}
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/31" ;;
  "issue view") echo '{"number":31,"state":"OPEN","labels":[],"url":"u"}' ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function ghCalls(): string[] {
  const log = join(dir, 'gh-calls.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

// Solo cards live without any git remote — solo never touches a provider.
async function soloCard(title: string): Promise<string> {
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
  git('commit -q -m "feat: solo work"');
  return note.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-delivery-solo-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-delivery-solo-bin-'));
  stubGh(join(dir, 'gh-calls.log'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\ngh-calls.log\ndeck.rules.yaml\n');
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

describe('solo/local delivery', () => {
  test('successful guarded local integration completes with local provenance only', async () => {
    store = await openStore(dir);
    const id = await soloCard('solo success card');
    const outcome = await archiveVerb(store, id);
    expect(outcome.delivery.state).toBe('pending');
    expect(outcome.delivery.prNumber).toBeNull(); // no provider effect
    const final = await finalizeDelivery(store, id);
    expect(final.result).toBe('delivered');
    expect(final.card.lane).toBe('done');
    const row = newestDelivery(store, id)!;
    expect(row.provenance).toBe('local');
    expect(row.mergeMethod).toBe('local-no-ff');
    expect(row.mergeSha).toMatch(/^[0-9a-f]{40}$/);
    // The merge commit sits on main; the card branch is intact.
    git('checkout -q main');
    expect(git('log --oneline -1')).toMatch(/merge:/);
    expect(git('rev-parse --verify --quiet refs/heads/' + branchFor(final.card, 'feat')).trim()).not.toBe('');
    // No hosted assurance: no PR was ever created.
    expect(ghCalls().some((call) => call.includes('pr create'))).toBe(false);
  });

  test('a conflicting base aborts the merge, restores base and keeps the card undelivered', async () => {
    store = await openStore(dir);
    const id = await soloCard('solo conflict card');
    const branch = branchFor(store.getVerbItem(id), 'feat');
    // Diverge main from the branch with a conflicting edit of work.txt.
    git('checkout -q main');
    writeFileSync(join(dir, 'work.txt'), 'conflicting main content\n');
    git('add work.txt');
    git('commit -q -m "main diverges"');
    git(`checkout -q ${JSON.stringify(branch)}`);
    await archiveVerb(store, id);
    await expect(finalizeDelivery(store, id)).rejects.toThrow(/conflict|abort/i);
    expect(store.getVerbItem(id).lane).toBe('verify');
    expect(newestDelivery(store, id)!.state).toBe('pending');
    // Not mid-merge: main still holds only its own divergence.
    git('checkout -q main');
    expect(readFileSync(join(dir, 'work.txt'), 'utf8')).toBe('conflicting main content\n');
    expect(git('log --oneline')).not.toMatch(/merge:/);
  });

  test('a wrong checkout refuses before any merge', async () => {
    store = await openStore(dir);
    const id = await soloCard('solo wrong checkout card');
    await archiveVerb(store, id);
    git('checkout -q main'); // integration requires the owned branch checked out
    await expect(finalizeDelivery(store, id)).rejects.toThrow(/owns/);
    expect(store.getVerbItem(id).lane).toBe('verify');
  });

  test('a solo completion never claims hosted review or push assurance', async () => {
    store = await openStore(dir);
    const id = await soloCard('solo claim card');
    await archiveVerb(store, id);
    await finalizeDelivery(store, id);
    const row = newestDelivery(store, id)!;
    expect(row.prNumber).toBeNull();
    expect(row.prUrl).toBeNull();
    expect(row.provenance).toBe('local');
    // No remote existed at all and none was needed — the delivery succeeded.
    expect(git('remote')).toBe('');
  });
});

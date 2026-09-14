import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveLane } from '../../src/core/board/lanes.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { enrollPolicy, getPolicy } from '../../src/core/board/rules.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import { archiveVerb } from '../../src/core/engine/archive.ts';
import { finalizeDelivery } from '../../src/core/engine/delivery.ts';
import { evaluateEligibility } from '../../src/core/engine/evidence.ts';
import type { Delta } from '../../src/core/board/types.ts';

// Task 4.2 — unfinished cards migrated under the E05 delivery law are NOT
// implicitly adopted: no policy → preparation and finalization refuse; legacy
// evidence without identity stays unknown; explicit enrollment is the only
// door; historical done cards remain untouched.
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
  "issue create") echo "https://github.com/o/r/issues/55" ;;
  "issue view") echo "{\\"number\\":55,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

const DELTA: Delta = {
  op: 'ADDED' as const,
  requirement: 'Requirement: Migrated Widget',
  text: 'The widget SHALL migrate cleanly.',
};

// A card that predates the delivery law: published, through verify, delivered
// under the old writer — i.e. exactly the unfinished population E05 inherits.
async function legacyPendingCard(title: string): Promise<string> {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [DELTA],
    tasks: [],
    openQuestions: [],
  });
  await publishSpec(store, note.id);
  moveLane(store, note.id, 'active', 'engine');
  moveLane(store, note.id, 'verify', 'engine');
  return note.id;
}

// A done card from before migration — the archive of the old law.
async function historicalDoneCard(title: string): Promise<string> {
  const id = await legacyPendingCard(title);
  moveLane(store, id, 'done', 'engine');
  return id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-delivery-migration-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-delivery-migration-bin-'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m "c1"');
  stubGh();
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

describe('delivery migration (unfinished-card policy enrollment)', () => {
  test('a migrated pending card has no policy and preparation refuses', async () => {
    const id = await legacyPendingCard('legacy pending card');
    expect(getPolicy(store, id)).toBeUndefined();
    await expect(archiveVerb(store, id)).rejects.toThrow(/no enrolled delivery\/evidence policy/);
  });

  test('finalization refuses an unenrolled pending card', async () => {
    const id = await legacyPendingCard('unenrolled verify card');
    await expect(finalizeDelivery(store, id)).rejects.toThrow(/no enrolled delivery\/evidence policy/);
  });

  test('evidence for an unenrolled migrated card evaluates unknown (no legacy auto-acceptance)', async () => {
    const id = await legacyPendingCard('unknown evidence card');
    const evaluation = await evaluateEligibility(store, id);
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.reasons.join(' ')).toMatch(/no enrolled|policy/i);
  });

  test('explicit enrollment opens the door and versions the policy', async () => {
    const id = await legacyPendingCard('enrolled migrated card');
    const policy = enrollPolicy(store, id, { mode: 'team' });
    expect(policy.mode).toBe('team');
    expect(policy.version).toBe(1);
    const again = getPolicy(store, id);
    expect(again?.cardId).toBe(id);
    // a second enrollment bumps the version — evidence bound to v1 goes stale
    const bumped = enrollPolicy(store, id, { mode: 'team' });
    expect(bumped.version).toBe(2);
  });

  test('historical done cards stay done with no implicit policy or delivery rows', async () => {
    const doneId = await historicalDoneCard('old law done card');
    expect(store.getVerbItem(doneId).lane).toBe('done');
    expect(getPolicy(store, doneId)).toBeUndefined();
    const deliveries = store.db.all<{ card_id: string }>('SELECT card_id FROM deliveries').filter((row) => row.card_id === doneId);
    expect(deliveries).toHaveLength(0);
  });
});

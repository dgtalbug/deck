// Task 4.4 — team PR preparation over the provider-intent ledger: successful
// prepare leaves the card in verify with a PENDING delivery (an open PR is
// never done), a failed prepare can be retried (reservation released), a dirty
// tree and stale evidence refuse before any provider effect, and no checkout
// reservation is held while waiting for human review.
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
import { newestDelivery } from '../../src/core/engine/delivery.ts';
import { evaluateEligibility } from '../../src/core/engine/evidence.ts';
import { listOperations } from '../../src/core/engine/ownership.ts';
import { branchFor } from '../../src/core/engine/slug.ts';
import type { GroomProposal } from '../../src/core/board/types.ts';

let dir: string;
let origin: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;
let prCreateFails = false;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

// gh stub with a call log; `pr create` fail/succeed is scriptable per test.
function stubGh(logPath: string): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(logPath)}
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/77" ;;
  "issue view") echo '{"number":77,"state":"OPEN","labels":[],"url":"u"}' ;;
  "pr create")
    if [ -f ${JSON.stringify(join(dir, 'pr-fails'))} ]; then
      echo "provider refused" >&2
      exit 4
    fi
    echo "https://github.com/o/r/pull/78"
    ;;
  "pr list") echo '[]' ;;
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

function writeRules(check: string): void {
  writeFileSync(
    join(dir, 'deck.rules.yaml'),
    ['version: 1', 'principles:', '  - id: unit-tests', '    rule: tests pass', `    check: ${check}`].join('\n'),
  );
}

async function prepareableCard(title: string, delta?: import('../../src/core/board/types.ts').Delta): Promise<string> {
  const note = store.addNote(title);
  const proposal: GroomProposal = {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: delta === undefined ? [] : [delta],
    tasks: [],
    openQuestions: [],
  };
  convertToVerbItem(store, proposal);
  await publishSpec(store, note.id);
  moveLane(store, note.id, 'active', 'engine');
  moveLane(store, note.id, 'verify', 'engine');
  enrollPolicy(store, note.id, { mode: 'team' });
  // The card's owned branch with committed work; review binds the checkout to
  // this branch, so preparation starts on it.
  const branch = branchFor(store.getVerbItem(note.id), 'feat');
  git(`checkout -q -b ${JSON.stringify(branch)}`);
  writeFileSync(join(dir, 'work.txt'), `${title}\n`);
  if (delta !== undefined) {
    // Pair the requirement's 4-word slug with a source file + test file so
    // review's snapshot pairing stands.
    const slug = delta.requirement.replace(/^Requirement:\s*/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).slice(0, 4).join('-');
    writeFileSync(join(dir, `src-${slug}.ts`), 'export {};\n');
    writeFileSync(join(dir, `${slug}.test.ts`), 'test.todo("pairs");\n');
  }
  git('add .');
  git('commit -q -m "feat: prepare work"');
  return note.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-delivery-prepare-'));
  origin = mkdtempSync(join(tmpdir(), 'deck-delivery-prepare-origin-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-delivery-prepare-bin-'));
  stubGh(join(dir, 'gh-calls.log'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  execSync(`git init --bare -q ${JSON.stringify(origin)}`, { stdio: 'ignore' });
  git(`remote add origin ${JSON.stringify(origin)}`);
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\ngh-calls.log\ndeck.rules.yaml\npr-fails\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m c1');
  writeRules('exit 0');
  rmSync(join(dir, 'pr-fails'), { force: true });
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

describe('team PR preparation', () => {
  test('successful preparation records a pending delivery and keeps the card in verify', async () => {
    store = await openStore(dir);
    const id = await prepareableCard('prep success card');
    const outcome = await archiveVerb(store, id);
    expect(outcome.card.lane).toBe('verify'); // an open PR is NOT completed work
    expect(outcome.delivery.state).toBe('pending');
    expect(outcome.delivery.prNumber).toBe(78);
    expect(outcome.warnings.join(' ')).toMatch(/delivery pending/);
    const delivery = newestDelivery(store, id)!;
    expect(delivery.mode).toBe('team');
    expect(delivery.headSha).toBeTruthy();
    expect(ghCalls().some((call) => call.includes('pr create'))).toBe(true);
  });

  test('a failed prepare is retryable — no reservation or delivery is stranded', async () => {
    store = await openStore(dir);
    const id = await prepareableCard('prep retry card');
    writeFileSync(join(dir, 'pr-fails'), '1');
    await expect(archiveVerb(store, id)).rejects.toThrow(/pr create/);
    // The failed attempt left no delivery record and no unsettled checkout
    // reservation — the retry starts clean.
    expect(newestDelivery(store, id)).toBeUndefined();
    expect(
      listOperations(store).filter((op) => op.cardId === id && (op.state === 'reserved' || op.state === 'active')),
    ).toHaveLength(0);
    rmSync(join(dir, 'pr-fails'));
    const outcome = await archiveVerb(store, id);
    expect(outcome.delivery.state).toBe('pending');
    expect(outcome.delivery.reused).toBe(false);
  });

  test('a dirty tree refuses preparation before any provider effect', async () => {
    store = await openStore(dir);
    const id = await prepareableCard('prep dirty card');
    writeFileSync(join(dir, 'uncommitted.txt'), 'dirty\n');
    await expect(archiveVerb(store, id)).rejects.toThrow(/working tree is not clean/);
    expect(ghCalls().some((call) => call.includes('pr create'))).toBe(false);
    expect(newestDelivery(store, id)).toBeUndefined();
  });

  test('stale evidence that review cannot refresh refuses preparation', async () => {
    store = await openStore(dir);
    const id = await prepareableCard('prep stale evidence card', {
      op: 'ADDED',
      requirement: 'Requirement: Prep Stale Evidence',
      text: 'The card SHALL keep evidence current.',
    } as import('../../src/core/board/types.ts').Delta);
    // A policy version bump invalidates previously captured evidence; review
    // re-captures configured checks, but a FAILING check leaves the criterion
    // unsatisfied — preparation must refuse either way.
    enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    writeRules('exit 3');
    await expect(archiveVerb(store, id)).rejects.toThrow(/evidence is not current|blocked/);
    expect((await evaluateEligibility(store, id)).eligible).toBe(false);
    expect(ghCalls().some((call) => call.includes('pr create'))).toBe(false);
  });

  test('no checkout reservation is held while waiting for human review', async () => {
    store = await openStore(dir);
    const id = await prepareableCard('prep waiting card');
    await archiveVerb(store, id);
    // Waiting for the merge is persisted delivery state, not a checkout lock.
    const unsettled = listOperations(store).filter(
      (op) => op.cardId === id && (op.state === 'reserved' || op.state === 'active' || op.state === 'recovery-required'),
    );
    expect(unsettled).toHaveLength(0);
    expect(store.getVerbItem(id).lane).toBe('verify');
  });
});

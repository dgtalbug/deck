// engine/ownership — make-build-execution-trustworthy paired tests: the
// writer-version fence, the operations-ledger migration, atomic start
// reservations (same-card races cross-process via a file barrier), WIP
// counting reservations, prehook-refusal compensation, crash recovery,
// canonical-checkout guarding (symlink aliases included) and explicit
// reconciliation with stale-owner fencing.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { startVerb } from '../../src/core/engine/verbs.ts';
import {
  canonicalCheckout,
  completeOperation,
  listUnsettledOperations,
  OperationConflictError,
  reconcileOperation,
  reserveOperation,
  StaleOperationError,
} from '../../src/core/engine/ownership.ts';
import type { GroomProposal } from '../../src/core/board/types.ts';

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
  "issue create") echo "https://github.com/o/r/issues/77" ;;
  "issue view") echo '{"number":77,"state":"OPEN","labels":[],"url":"u"}' ;;
  "issue edit") echo ok ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function groomed(title: string): string {
  const note = store.addNote(title);
  const proposal: GroomProposal = {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['implement'],
    openQuestions: [],
  };
  convertToVerbItem(store, proposal);
  return note.id;
}

// Crash-point + race workers run as separate processes against the same
// board; the script reports one JSON line on stdout.
function writeWorker(name: string, projectPath: string, cardId: string, readyFile: string, goFile: string): string {
  const path = join(dir, 'workers', name);
  writeFileSync(
    path,
    `import { openStore } from '${join(import.meta.dir, '..', '..', 'src', 'core', 'board', 'store.ts')}';
import { reserveOperation } from '${join(import.meta.dir, '..', '..', 'src', 'core', 'engine', 'ownership.ts')}';
import { existsSync, writeFileSync } from 'node:fs';
const store = await openStore(${JSON.stringify(projectPath)});
writeFileSync(${JSON.stringify(readyFile)}, '1');
while (!existsSync(${JSON.stringify(goFile)})) {}
try {
  const operation = reserveOperation(store, ${JSON.stringify(cardId)}, 'start');
  console.log(JSON.stringify({ ok: true, id: operation.id }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, name: error.name, message: error.message }));
}
`,
  );
  return path;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-ownership-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-ownership-bin-'));
  stubGh();
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\nworkers/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m c1');
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

function doneEvents(): unknown[] {
  return store.raw().query("SELECT payload FROM events WHERE type = 'card.done'").all() as unknown[];
}

describe('writer-version fence', () => {
  test('a board written by a newer deck refuses this binary', async () => {
    store.raw()
      .query("INSERT INTO deck_meta (key, value) VALUES ('min_writer_version', '999.0.0') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run();
    let message = '';
    try {
      await openStore(dir);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('requires deck >= 999.0.0');
  });

  test('operations ledger round-trips a fresh and an existing board', async () => {
    // fresh board: the ledger exists and survives reopen with data intact
    const id = groomed('ledger round trip');
    expect(store.raw().query("SELECT name FROM sqlite_master WHERE type='table' AND name='operations'").get()).toBeTruthy();
    const reopened = await openStore(dir);
    expect(reopened.getCard(id).title).toBe('ledger round trip');
    expect(reopened.raw().query("SELECT name FROM sqlite_master WHERE type='table' AND name='operations'").get()).toBeTruthy();
    reopened.raw().close();
  });

  test('legacy active work surfaces as recovery-required and fences until reconciled', async () => {
    const active = groomed('legacy active probe');
    moveLane(store, active, 'active', 'engine');
    // Simulate the pre-ledger board: wipe the ledger, the one-time sweep
    // marker and its migration record, then reopen — the migration's upgrade
    // sweep must fence the active card.
    store.raw().exec('DELETE FROM operations');
    store.raw().exec("DELETE FROM deck_meta WHERE key = 'legacy_ownership_swept'");
    store.raw().exec("DELETE FROM migration_runs WHERE migration = '20260919120000_control_plane_baseline'");
    store.raw().close();
    store = await openStore(dir);
    const unsettled = listUnsettledOperations(store);
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]).toMatchObject({ cardId: active, state: 'recovery-required', owner: 'legacy' });
    // A new start on the same checkout refuses while the legacy row stands.
    const other = groomed('blocked by legacy probe');
    expect(() => reserveOperation(store, other, 'start')).toThrow(OperationConflictError);
    // Explicit reconciliation releases the fence; no guessed ownership.
    reconcileOperation(store, unsettled[0]!.id, 'confirm');
    expect(listUnsettledOperations(store)).toHaveLength(0);
    expect(() => reserveOperation(store, other, 'start')).not.toThrow();
  });
});

describe('atomic start reservation', () => {
  test('same-card double reserve refuses; completion frees the card', () => {
    const id = groomed('double reserve probe');
    const operation = reserveOperation(store, id, 'start');
    expect(operation.state).toBe('reserved');
    expect(() => reserveOperation(store, id, 'start')).toThrow(OperationConflictError);
    completeOperation(store, operation.id);
    expect(listUnsettledOperations(store)).toHaveLength(0);
  });

  test('WIP counts reservations — parallel different-card starts cannot exceed the limit', async () => {
    const one = groomed('wip active one');
    const two = groomed('wip active two');
    moveLane(store, one, 'active', 'engine');
    moveLane(store, two, 'active', 'engine');
    const reserved = groomed('wip reserved card');
    reserveOperation(store, reserved, 'start'); // 2 active + 1 reserved = limit 3
    const contender = groomed('wip contender card');
    let error: unknown;
    try {
      await startVerb(store, contender, 'feat');
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).name).toBe('WipLimitError');
    expect(store.getVerbItem(contender).lane).toBe('groomed');
  });

  test('prehook refusal compensates the reservation — no public active transition', async () => {
    writeFileSync(
      join(dir, 'deck.rules.yaml'),
      "version: 1\nhooks:\n  - on: feat\n    pre: 'echo no >&2; exit 1'\n",
    );
    const id = groomed('prehook refusal probe');
    let error: unknown;
    try {
      await startVerb(store, id, 'feat');
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).name).toBe('PreHookBlockedError');
    expect(store.getVerbItem(id).lane).toBe('groomed');
    expect(listUnsettledOperations(store)).toHaveLength(0); // compensated
    expect(doneEvents()).toHaveLength(0);
  });
});

describe('cross-process races and recovery', () => {
  test('barrier-driven same-card race yields one owner; the loser changes nothing', async () => {
    const id = groomed('barrier race probe');
    mkdirWorker();
    const readyA = join(dir, 'workers', 'ready-a');
    const readyB = join(dir, 'workers', 'ready-b');
    const go = join(dir, 'workers', 'go');
    const scriptA = writeWorker('worker-a.ts', dir, id, readyA, go);
    const scriptB = writeWorker('worker-b.ts', dir, id, readyB, go);
    const procA = Bun.spawn(['bun', 'run', scriptA], { stdout: 'pipe', stderr: 'pipe' });
    const procB = Bun.spawn(['bun', 'run', scriptB], { stdout: 'pipe', stderr: 'pipe' });
    while (!existsSync(readyA) || !existsSync(readyB)) {
      await Bun.sleep(10);
      if (procA.exitCode !== null || procB.exitCode !== null) {
        throw new Error(
          `worker died early: A=${await new Response(procA.stderr).text()} B=${await new Response(procB.stderr).text()}`,
        );
      }
    }
    writeFileSync(go, '1');
    const [outA, outB] = await Promise.all([new Response(procA.stdout).text(), new Response(procB.stdout).text()]);
    await procA.exited;
    await procB.exited;
    const results = [outA.trim(), outB.trim()].map((line) => JSON.parse(line) as { ok: boolean; name?: string });
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).every((result) => result.name === 'OperationConflictError')).toBe(true);
    // The winner's reservation stands; the loser added no state.
    const unsettled = listUnsettledOperations(store);
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]).toMatchObject({ cardId: id, state: 'reserved' });
    expect(store.getVerbItem(id).lane).toBe('groomed'); // public transition not yet made
  });

  test('crash after reservation leaves the row untouched; reconcile releases and fences', async () => {
    const crashed = groomed('crashed start probe');
    mkdirWorker();
    const script = join(dir, 'workers', 'crash.ts');
    writeFileSync(
      script,
      `import { openStore } from '${join(import.meta.dir, '..', '..', 'src', 'core', 'board', 'store.ts')}';
import { reserveOperation } from '${join(import.meta.dir, '..', '..', 'src', 'core', 'engine', 'ownership.ts')}';
const store = await openStore(${JSON.stringify(dir)});
reserveOperation(store, ${JSON.stringify(crashed)}, 'start');
process.exit(9); // crash between reservation and completion
`,
    );
    const proc = Bun.spawn(['bun', 'run', script], { stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
    // Reopen: an open never revokes an owner implicitly — the crashed
    // worker's reserved row survives untouched and stays visibly unsettled.
    store = await openStore(dir);
    const unsettled = listUnsettledOperations(store);
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]).toMatchObject({ cardId: crashed, state: 'reserved' });
    // Unreconciled: a fresh start of another card refuses (uncertain checkout).
    const other = groomed('post crash contender');
    expect(() => reserveOperation(store, other, 'start')).toThrow(OperationConflictError);
    // Reconcile confirms the owned effects, then the checkout is free.
    reconcileOperation(store, unsettled[0]!.id, 'clean');
    expect(() => reserveOperation(store, other, 'start')).not.toThrow();
  });

  test('a stale owner cannot complete its operation after someone else reconciled it', async () => {
    const id = groomed('stale owner probe');
    const operation = reserveOperation(store, id, 'start');
    // Simulated external recovery: the human reconciles the row.
    reconcileOperation(store, operation.id, 'confirm');
    expect(() => completeOperation(store, operation.id)).toThrow(StaleOperationError);
  });
});

describe('canonical checkout ownership', () => {
  test('a foreign owner fences the checkout before publication or branch switch', async () => {
    const id = groomed('foreign owner probe');
    const operation = reserveOperation(store, id, 'start');
    // A second process's live reservation on the same checkout: insert a
    // foreign-owned active row (simulating another live deck process).
    store.raw()
      .query(
        "INSERT INTO operations (id, card_id, kind, owner, checkout, state, created_at, updated_at) VALUES ('op-foreign', ?, 'start', 'other-pid', ?, 'active', 't', 't')",
      )
      .run(id, canonicalCheckout(dir));
    let error: unknown;
    try {
      await startVerb(store, id, 'feat');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OperationConflictError);
    expect(store.getVerbItem(id).lane).toBe('groomed'); // no publication, no branch switch
    expect(existsSync(join(dir, '.git', 'refs', 'heads', 'feat'))).toBe(false);
    completeOperation(store, operation.id);
  });

  test('symlink aliases collapse to one canonical checkout', async () => {
    const alias = join(mkdtempSync(join(tmpdir(), 'deck-alias-')), 'link');
    symlinkSync(dir, alias);
    try {
      const storeViaAlias = await openStore(alias);
      const id = groomed('symlink alias probe');
      const operation = reserveOperation(storeViaAlias, id, 'start');
      expect(operation.checkout).toBe(canonicalCheckout(dir));
      // The same reservation is visible from the real path spelling.
      expect(listUnsettledOperations(store)).toHaveLength(1);
    } finally {
      rmSync(alias, { force: true });
    }
  });
});

function mkdirWorker(): void {
  mkdirSync(join(dir, 'workers'), { recursive: true });
}

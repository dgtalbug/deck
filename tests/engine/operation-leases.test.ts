// engine leases (P1-S01) — read-model discipline plus lease/fence semantics:
// readers never write, renewal is owner/fence conditional, expiry permits only
// explicit recovery, takeover fences the stale owner exactly once, and active
// or uncertain external effects block reassignment.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  openStore as openApplicationStore,
  openReadModel,
  type DocumentStore,
} from '../../src/core/board/store.ts';
import { LeaseStillActiveError, ReadOnlyStoreError, UncertainEffectsError, UninitializedProjectError } from '../../src/core/board/errors.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { SchemaMigrationRequiredError } from '../../src/core/board/open-state.ts';
import {
  DEFAULT_LEASE_MS,
  TakeoverLostError,
  completeOperation,
  listUnsettledOperations,
  operationHealth,
  recoverOperation,
  reconcileOperation,
  renewLease,
  reserveOperation,
  setOwnershipClockForTests,
  StaleOperationError,
} from '../../src/core/engine/ownership.ts';
import { writeFileSync } from 'node:fs';
import { tmpProject } from '../helpers.ts';

let project: ReturnType<typeof tmpProject>;
let store: DocumentStore;

function groomed(title: string): string {
  const note = store.addNote(title);
  return convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['do it'],
    openQuestions: [],
  }).id;
}

beforeAll(async () => {
  project = tmpProject('deck-leases-');
  store = await openApplicationStore(project.path);
});

afterAll(() => {
  setOwnershipClockForTests(undefined);
  project.cleanup();
});

describe('read model', () => {
  test('a read on an absent project refuses and creates nothing', async () => {
    const absent = join(tmpdir(), 'deck-absent-' + Date.now());
    expect(() => openReadModel(absent)).toThrow(UninitializedProjectError);
    expect(existsSync(absent)).toBe(false);
  });

  test('a pre-migration database refuses with the migration action', () => {
    const dir = join(tmpdir(), 'deck-premigration-' + Date.now());
    mkdirSync(join(dir, '.deck'), { recursive: true });
    const db = new Database(join(dir, '.deck', 'board.sqlite'));
    db.exec('CREATE TABLE cards (id TEXT)');
    db.close();
    expect(() => openReadModel(dir)).toThrow(SchemaMigrationRequiredError);
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads make no persistent writes while an operation holds a lease', async () => {
    const id = groomed('read probe');
    const operation = reserveOperation(store, id, 'start');
    const before = snapshotState(store);
    const reader = await openReadModel(project.path);
    expect(reader.mode).toBe('read');
    expect(reader.listCards().length).toBeGreaterThan(0);
    const after = snapshotState(store);
    expect(after).toBe(before);
    // The read store cannot write through the transactional gateway.
    expect(() => reader.reorder(id)).toThrow(ReadOnlyStoreError);
    reader.raw().close();
  });
});

function snapshotState(store: DocumentStore): string {
  const db = new Database(store.dbPath, { readonly: true });
  const state = JSON.stringify({
    meta: db.query('SELECT * FROM deck_meta ORDER BY key').all(),
    ops: db.query('SELECT id, owner, state, fence_token, lease_expires_at, updated_at FROM operations ORDER BY id').all(),
    cards: db.query('SELECT id, lane, updated_at FROM cards ORDER BY id').all(),
  });
  db.close();
  return state;
}

describe('lease lifecycle', () => {
  test('reservation carries a lease and renewal extends it', () => {
    const id = groomed('lease lifecycle');
    const operation = reserveOperation(store, id, 'start');
    expect(operation.leaseExpiresAt).not.toBeNull();
    expect(operation.fenceToken).toBe(0);
    let simulated = Date.now();
    setOwnershipClockForTests(() => new Date(simulated));
    const first = renewLease(store, operation.id, 0);
    simulated += DEFAULT_LEASE_MS / 2;
    const second = renewLease(store, operation.id, 0);
    expect(new Date(second.leaseExpiresAt!).getTime()).toBeGreaterThan(new Date(first.leaseExpiresAt!).getTime());
    setOwnershipClockForTests(undefined);
    completeOperation(store, operation.id);
  });

  test('health computes expiry without writing', () => {
    const id = groomed('health probe');
    const operation = reserveOperation(store, id, 'start');
    const before = snapshotState(store);
    let simulated = Date.now() - 1;
    setOwnershipClockForTests(() => new Date(simulated));
    expect(operationHealth(store).find((h) => h.operation.id === operation.id)?.expired).toBe(false);
    simulated = Date.now() + DEFAULT_LEASE_MS * 2;
    expect(operationHealth(store).find((h) => h.operation.id === operation.id)?.expired).toBe(true);
    setOwnershipClockForTests(undefined);
    const after = snapshotState(store);
    expect(after).toBe(before);
    reconcileOperation(store, operation.id, 'clean');
  });

  test('a live lease refuses explicit recovery', () => {
    const id = groomed('live lease probe');
    const operation = reserveOperation(store, id, 'start');
    expect(() => recoverOperation(store, operation.id, 'takeover')).toThrow(LeaseStillActiveError);
    expect(() => recoverOperation(store, operation.id, 'cancel')).toThrow(LeaseStillActiveError);
    reconcileOperation(store, operation.id, 'clean');
  });

  test('takeover after expiry advances the fence once and fences the stale owner', () => {
    const id = groomed('takeover probe');
    const operation = reserveOperation(store, id, 'start');
    // Foreign owner crashed: expiry passes, no uncertain effects remain.
    store.raw()
      .query("UPDATE operations SET owner = 'dead-worker' WHERE id = ?")
      .run(operation.id);
    let simulated = Date.now() + DEFAULT_LEASE_MS * 3;
    setOwnershipClockForTests(() => new Date(simulated));
    const taken = recoverOperation(store, operation.id, 'takeover');
    expect(taken.owner).not.toBe('dead-worker');
    expect(taken.fenceToken).toBe(1);
    // The refreshed lease protects the new owner from an immediate re-taking.
    expect(() => recoverOperation(store, operation.id, 'takeover')).toThrow(LeaseStillActiveError);
    // The stale owner's renewal and completion refuse against the new state.
    expect(() => renewLease(store, operation.id, 0)).toThrow(StaleOperationError);
    store.raw().query("UPDATE operations SET owner = 'dead-worker' WHERE id = ?").run(operation.id);
    expect(() => completeOperation(store, operation.id)).toThrow(StaleOperationError);
    // Once the new lease also expires, recovery is possible again — each
    // takeover bumps the fence, so every older owner stays fenced.
    simulated += DEFAULT_LEASE_MS * 3;
    const retaken = recoverOperation(store, operation.id, 'takeover');
    expect(retaken.fenceToken).toBe(2);
    setOwnershipClockForTests(undefined);
    reconcileOperation(store, operation.id, 'clean');
  });

  test('uncertain external effects block reassignment', () => {
    const id = groomed('uncertain effect probe');
    const operation = reserveOperation(store, id, 'start');
    store.raw()
      .query("UPDATE operations SET owner = 'dead-worker', lease_expires_at = '2020-01-01T00:00:00Z' WHERE id = ?")
      .run(operation.id);
    const ts = new Date().toISOString();
    store.raw()
      .query(
        `INSERT INTO provider_operations (id, card_id, kind, provider, repo, project_id, marker, payload_revision, payload, state, created_at, updated_at)
         VALUES ('pop-x', ?, 'issue-create', 'github', 'o/r', 'p', 'm', 0, '{}', 'uncertain', ?, ?)`,
      )
      .run(id, ts, ts);
    expect(() => recoverOperation(store, operation.id, 'takeover')).toThrow(UncertainEffectsError);
    store.raw().query("UPDATE provider_operations SET state = 'succeeded' WHERE id = 'pop-x'").run();
    const taken = recoverOperation(store, operation.id, 'takeover');
    expect(taken.fenceToken).toBe(1);
    reconcileOperation(store, operation.id, 'clean');
  });

  test('legacy recovery-required rows without a lease are recoverable, once', () => {
    const id = groomed('legacy no-lease probe');
    const ts = new Date().toISOString();
    store.raw()
      .query(
        `INSERT INTO operations (id, card_id, kind, owner, checkout, state, created_at, updated_at)
         VALUES ('op-legacy-x', ?, 'start', 'legacy', '/w', 'recovery-required', ?, ?)`,
      )
      .run(id, ts, ts);
    const taken = recoverOperation(store, 'op-legacy-x', 'cancel');
    expect(taken.state).toBe('compensated');
    expect(taken.fenceToken).toBe(1);
    expect(() => recoverOperation(store, 'op-legacy-x', 'cancel')).toThrow(/settled operations only/);
  });

  test('cancel preserves unrelated cards, lanes and operations', () => {
    const keep = groomed('unrelated keep');
    const drop = groomed('cancel target');
    const keeper = reserveOperation(store, keep, 'start');
    const victim = reserveOperation(store, drop, 'start');
    const before = store.raw().query('SELECT id, lane FROM cards ORDER BY id').all();
    store.raw()
      .query("UPDATE operations SET lease_expires_at = '2020-01-01T00:00:00Z' WHERE id = ?")
      .run(victim.id);
    recoverOperation(store, victim.id, 'cancel');
    const after = store.raw().query('SELECT id, lane FROM cards ORDER BY id').all();
    expect(after).toEqual(before);
    expect(listUnsettledOperations(store).map((op) => op.id)).toContain(keeper.id);
    completeOperation(store, keeper.id);
  });
});

describe('two-process takeover race', () => {
  test('exactly one recovery wins when two processes race an expired lease', async () => {
    const id = groomed('race takeover probe');
    const operation = reserveOperation(store, id, 'start');
    store.raw()
      .query("UPDATE operations SET owner = 'dead-worker', lease_expires_at = '2020-01-01T00:00:00Z' WHERE id = ?")
      .run(operation.id);
    const worker = (tag: string) => {
      const script = join(project.path, `race-${tag}.ts`);
      const ready = join(project.path, `ready-${tag}`);
      writeFileSync(
        script,
        `import { openStore } from '${join(import.meta.dir, '..', '..', 'src', 'core', 'board', 'store.ts')}';
import { recoverOperation, TakeoverLostError, OperationConflictError } from '${join(import.meta.dir, '..', '..', 'src', 'core', 'engine', 'ownership.ts')}';
import { LeaseStillActiveError } from '${join(import.meta.dir, '..', '..', 'src', 'core', 'board', 'errors.ts')}';
import { writeFileSync } from 'node:fs';
const store = await openStore(${JSON.stringify(project.path)});
writeFileSync(${JSON.stringify(ready)}, '1');
await Bun.sleep(200); // both workers have opened before either recovers
try {
  recoverOperation(store, ${JSON.stringify(operation.id)}, 'takeover');
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, name: error instanceof TakeoverLostError || error instanceof LeaseStillActiveError || error instanceof OperationConflictError ? error.constructor.name : 'Unexpected' }));
}
`,
      );
      return Bun.spawn(['bun', 'run', script], { stdout: 'pipe', stderr: 'pipe' });
    };
    const a = worker('a');
    const b = worker('b');
    const [outA, outB, errA, errB] = await Promise.all([
      new Response(a.stdout).text(),
      new Response(b.stdout).text(),
      new Response(a.stderr).text(),
      new Response(b.stderr).text(),
    ]);
    await a.exited;
    await b.exited;
    if (errA.trim() || errB.trim()) {
      throw new Error(`worker stderr — a: ${errA.trim() || 'none'} | b: ${errB.trim() || 'none'}`);
    }
    const results = [outA.trim(), outB.trim()].map((line) => JSON.parse(line) as { ok: boolean; name?: string });
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => r.name === 'TakeoverLostError' || r.name === 'LeaseStillActiveError')).toBe(true);
    const { operations } = await import('../../src/core/board/schema.ts');
    const { eq } = await import('drizzle-orm');
    const row = store.db.select().from(operations).where(eq(operations.id, operation.id)).get();
    expect(row?.fenceToken).toBe(1);
    setOwnershipClockForTests(undefined);
    reconcileOperation(store, operation.id, 'clean');
  });
});

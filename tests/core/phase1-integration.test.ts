// Phase 1 cross-story integration — one fixture chains the shared contracts
// in order: a legacy database migrates authoritatively, a read model touches
// nothing, a crashed owner's lease is recovered through the fence, a guarded
// external effect reconciles its marker instead of re-creating, and a durable
// consumer acknowledges delivery in order. Each stage uses only the public
// doors the corresponding story shipped.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { openStore, openReadModel, type DocumentStore } from '../../src/core/board/store.ts';
import { runMigrations, migrationStatus } from '../../src/core/board/migrate.ts';
import {
  listUnsettledOperations,
  reconcileOperation,
  recoverOperation,
  renewLease,
  reserveOperation,
  setOwnershipClockForTests,
} from '../../src/core/engine/ownership.ts';
import { guardEffect } from '../../src/core/board/provider-operations.ts';
import { acknowledge, pendingFor, registerConsumer } from '../../src/core/events/outbox.ts';
import { tmpProject } from '../helpers.ts';

let project: ReturnType<typeof tmpProject>;
let store: DocumentStore;

function snapshot(dbPath: string): string {
  const db = new Database(dbPath);
  const state = JSON.stringify({
    meta: db.query('SELECT * FROM deck_meta ORDER BY key').all(),
    ops: db.query('SELECT id, owner, state, fence_token FROM operations ORDER BY id').all(),
    events: db.query('SELECT COUNT(*) AS n FROM events').get(),
  });
  db.close();
  return state;
}

beforeAll(async () => {
  project = tmpProject('deck-phase1-int-');
});

afterAll(() => {
  setOwnershipClockForTests(undefined);
  project.cleanup();
});

describe('phase 1 cross-story chain', () => {
  test('migration → read model → lease recovery → guarded effect → acknowledged delivery', async () => {
    const dbPath = join(project.path, '.deck', 'board.sqlite');

    // Stage 1 — a pre-deck database (empty file, no schema) migrates
    // authoritatively through the whole chain, once.
    mkdirSync(join(project.path, '.deck'), { recursive: true });
    new Database(dbPath).close();
    const outcome = runMigrations(new Database(dbPath), project.path, { dbPath });
    expect(outcome.applied.length).toBeGreaterThan(0);
    expect(migrationStatus(new Database(dbPath)).every((entry) => entry.state === 'completed')).toBe(true);

    // Stage 2 — a note created through the application door events the log.
    store = await openStore(project.path);
    const note = store.addNote('integration probe');
    expect(existsSync(dbPath)).toBe(true);

    // Stage 3 — a read model over a live lease changes nothing persistently.
    const operation = reserveOperation(store, note.id, 'start');
    const before = snapshot(dbPath);
    const reader = await openReadModel(project.path);
    expect(reader.listCards().length).toBe(1);
    expect(snapshot(dbPath)).toBe(before);
    reader.raw().close();

    // Stage 4 — the owner dies; expiry permits exactly one fenced takeover.
    store.raw().query("UPDATE operations SET owner = 'dead-worker', lease_expires_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(operation.id);
    const taken = recoverOperation(store, operation.id, 'takeover');
    expect(taken.fenceToken).toBe(1);
    // The dead owner cannot renew against the advanced fence.
    expect(() => renewLease(store, operation.id, 0)).toThrow();
    setOwnershipClockForTests(undefined);
    reconcileOperation(store, operation.id, 'clean');

    // Stage 5 — a guarded external effect that already succeeded remotely is
    // reconciled by marker; the effect never runs twice.
    let effectRuns = 0;
    await expect(guardEffect(
      store,
      {
        cardId: note.id,
        kind: 'issue-create',
        repo: 'o/r',
        projectId: 'p',
        marker: `deck:p:${note.id}`,
        payload: { title: 'probe' },
      },
      'worker-a',
      async () => [],
      async () => {
        effectRuns += 1;
        throw new Error('remote accepted, response lost');
      },
      (n: string) => ({ remoteId: n }),
    )).rejects.toThrow(/response lost/);
    expect(effectRuns).toBe(1);
    let retriedRuns = 0;
    const retried = await guardEffect(
      store,
      {
        cardId: note.id,
        kind: 'issue-create',
        repo: 'o/r',
        projectId: 'p',
        marker: `deck:p:${note.id}`,
        payload: { title: 'probe' },
      },
      'worker-b',
      async () => [{ remoteId: '7', remoteUrl: 'u' }],
      async () => {
        retriedRuns += 1;
        return '8';
      },
      (n: string) => ({ remoteId: n }),
    );
    expect(retriedRuns).toBe(0);
    expect(retried.reused).toBe(true);

    // Stage 6 — a durable consumer registers explicitly and acknowledges in
    // order across the whole committed log.
    registerConsumer(store.db, 'integrator', { from: 'beginning' });
    const pending = pendingFor(store.db, 'integrator');
    expect(pending.length).toBeGreaterThan(0);
    for (const entry of pending) {
      acknowledge(store.db, 'integrator', entry.rowid);
    }
    expect(pendingFor(store.db, 'integrator')).toHaveLength(0);

    // No unsettled operation or uncertain effect is left behind.
    expect(listUnsettledOperations(store)).toHaveLength(0);
    store.raw().close();
  });
});

// P1-S05 resumable external effects — guarded saga steps over the provider
// ledger: intent persists before every effect, observe-before-retry reuses a
// crash-after-success result instead of creating a second resource, multiple
// matches stay conflicted, stale owners cannot settle, and cleanup/close keep
// retained tombstones.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import {
  claimIntent,
  completeIntent,
  getOperation,
  guardEffect,
  markUncertain,
  recordIntent,
  recordTombstone,
  reconcileOperation,
} from '../../../src/core/board/provider-operations.ts';
import { providerOperations } from '../../../src/core/board/schema.ts';
import { tmpProject } from '../../helpers.ts';

let project: ReturnType<typeof tmpProject>;
let store: DocumentStore;

beforeEach(async () => {
  project = tmpProject('deck-saga-');
  store = await openStore(project.path);
});

afterEach(() => {
  project.cleanup();
});

function intentInput(cardId: string, marker: string) {
  return {
    cardId,
    kind: 'issue-create' as const,
    repo: 'o/r',
    projectId: 'proj',
    marker,
    payload: { title: 'probe' },
    operationId: 'op-x',
    step: 'issue-create',
  };
}

describe('guarded saga steps', () => {
  test('crash after create success reconciles the marker instead of re-creating', async () => {
    const cardId = 'card-1';
    let effectRuns = 0;
    // First attempt: the effect "succeeds remotely" but the process dies
    // before completion is persisted — simulated by an effect that runs but
    // throws afterwards, marking the row uncertain.
    await expect(
      guardEffect(
        store,
        intentInput(cardId, 'deck:proj:card-1'),
        'worker-a',
        async () => [], // nothing visible YET (eventual consistency window)
        async () => {
          effectRuns += 1;
          throw new Error('crash after the provider accepted the create');
        },
        (n: string) => ({ remoteId: n }),
      ),
    ).rejects.toThrow(/crash after the provider/);
    expect(effectRuns).toBe(1);
    const uncertain = store.db.select().from(providerOperations).all()[0]!;
    expect(uncertain.state).toBe('uncertain');

    // Retry: the marker is now visible — the observed result is reused and
    // the effect never runs again.
    let secondEffectRuns = 0;
    const retried = await guardEffect(
      store,
      intentInput(cardId, 'deck:proj:card-1'),
      'worker-b',
      async () => [{ remoteId: '42', remoteUrl: 'https://github.com/o/r/issues/42' }],
      async () => {
        secondEffectRuns += 1;
        return '99';
      },
      (n: string) => ({ remoteId: n }),
    );
    expect(secondEffectRuns).toBe(0);
    expect(retried.reused).toBe(true);
    expect(retried.row.state).toBe('reconciled');
    expect(retried.row.remoteId).toBe('42');
  });

  test('multiple matches stay conflicted and no replacement create runs', async () => {
    const cardId = 'card-2';
    let effectRuns = 0;
    await expect(
      guardEffect(
        store,
        intentInput(cardId, 'deck:proj:card-2'),
        'worker-a',
        async () => [
          { remoteId: '1', remoteUrl: 'u1' },
          { remoteId: '2', remoteUrl: 'u2' },
        ],
        async () => {
          effectRuns += 1;
          return '3';
        },
        (n: string) => ({ remoteId: n }),
      ),
    ).rejects.toThrow(/conflicted/);
    expect(effectRuns).toBe(0);
    const row = store.db.select().from(providerOperations).all()[0]!;
    expect(row.state).toBe('conflicted');
  });

  test('a stale owner cannot settle a step another worker owns', () => {
    const cardId = 'card-3';
    const row = recordIntent(store, intentInput(cardId, 'deck:proj:card-3'));
    claimIntent(store, row.id, 'worker-b');
    expect(() => completeIntent(store, row.id, 'worker-a', '7')).toThrow(/not owned by this worker/);
    // And a stale completion cannot overwrite the current observation.
    markUncertain(store, row.id, 'worker-b', 'response lost');
    expect(() => completeIntent(store, row.id, 'worker-a', '7')).toThrow(/not owned by this worker/);
  });

  test('cleanup and close retain tombstones for uncertain outcomes', () => {
    const cardId = 'card-4';
    const tomb = recordTombstone(store, {
      cardId,
      kind: 'issue-close',
      repo: 'o/r',
      projectId: 'proj',
      marker: 'deck:proj:card-4',
      target: '42',
    });
    expect(tomb.tombstone).toBe(1);
    expect(tomb.expectedRef).toBe('42');
    // An uncertain close keeps the tombstone and next action visible.
    claimIntent(store, tomb.id, 'worker-a');
    const uncertain = markUncertain(store, tomb.id, 'worker-a', 'close may have succeeded');
    expect(uncertain.state).toBe('uncertain');
    expect(uncertain.tombstone).toBe(1);
    expect(uncertain.nextAction).toMatch(/reconcile/);
  });

  test('one matching result reconciles an uncertain intent without effects', () => {
    const cardId = 'card-5';
    const row = recordIntent(store, intentInput(cardId, 'deck:proj:card-5'));
    claimIntent(store, row.id, 'worker-a');
    markUncertain(store, row.id, 'worker-a', 'response lost');
    const settled = reconcileOperation(store, row.id, [{ remoteId: '55', remoteUrl: 'u' }]);
    expect(settled.state).toBe('reconciled');
    expect(settled.remoteId).toBe('55');
    // A later reconcile is idempotent.
    expect(reconcileOperation(store, row.id, [{ remoteId: '55', remoteUrl: 'u' }]).state).toBe('reconciled');
  });
});

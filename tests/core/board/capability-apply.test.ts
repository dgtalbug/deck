import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  applyCapabilityPreview,
  capabilityStatementDigest,
  currentCapabilityStatements,
  persistCapabilityPreview,
  previewCapabilityRollback,
  previewCapabilityProjection,
  readCurrentCapabilityStatementStatus,
  type CapabilityPreview,
} from '../../../src/core/board/capability-projection.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { tmpProject } from '../../helpers.ts';

let store: DocumentStore;
let cleanup: () => void;

beforeEach(async () => {
  const project = tmpProject('deck-capability-apply-');
  cleanup = project.cleanup;
  store = await openStore(project.path);
});

afterEach(() => {
  cleanup();
});

function preview(text = 'source backed text', deltaId = 'delta:add'): CapabilityPreview {
  const statement = {
    capabilityId: 'capability:evidence',
    statementId: 'statement:lineage',
    text,
    digest: capabilityStatementDigest(text),
    state: 'current' as const,
  };
  return {
    baseDigest: previewCapabilityProjection([], [], new Map()).baseDigest,
    sourceDigest: 'a'.repeat(64),
    contentDigest: previewCapabilityProjection([statement], [], new Map()).contentDigest,
    changes: [{ op: 'add', deltaId, capabilityId: statement.capabilityId, statementId: statement.statementId, before: null, after: text }],
    conflicts: [],
    statements: [statement],
  };
}

describe('capability preview apply', () => {
  test('applies atomically and identical retry returns the prior version', () => {
    const stored = persistCapabilityPreview(store, 'batch:apply', preview());

    const first = applyCapabilityPreview(store, stored.id, { acceptedBy: 'reviewer', rationale: 'accepted preview' });
    const second = applyCapabilityPreview(store, stored.id, { acceptedBy: 'reviewer', rationale: 'accepted preview' });

    expect(first).toMatchObject({ version: 1, reused: false });
    expect(second).toMatchObject({ versionId: first.versionId, reused: true });
    expect(currentCapabilityStatements(store)).toHaveLength(1);
  });

  test('accepting one stored preview leaves other previews pending', () => {
    const first = persistCapabilityPreview(store, 'batch:first', preview('first text', 'delta:first'));
    const second = persistCapabilityPreview(store, 'batch:second', preview('second text', 'delta:second'));

    applyCapabilityPreview(store, first.id, { acceptedBy: 'reviewer', rationale: 'accept first only' });

    const rows = store.db.all('SELECT id, state FROM capability_previews ORDER BY id') as Array<{ id: string; state: string }>;
    expect(rows).toContainEqual({ id: first.id, state: 'accepted' });
    expect(rows).toContainEqual({ id: second.id, state: 'previewed' });
  });

  test('conflicted previews write no statements or versions', () => {
    const bad = { ...preview(), conflicts: [{ deltaId: 'delta:add', reason: 'conflict' }] };
    const stored = persistCapabilityPreview(store, 'batch:conflict', bad);

    expect(() => applyCapabilityPreview(store, stored.id, { acceptedBy: 'reviewer', rationale: 'nope' })).toThrow(/unresolved conflicts/);
    expect(currentCapabilityStatements(store)).toEqual([]);
    expect(store.db.all('SELECT * FROM capability_versions')).toEqual([]);
  });

  test('rejects stale preview and changed content under a reused delta id', () => {
    const first = persistCapabilityPreview(store, 'batch:first', preview('first text', 'delta:reuse'));
    applyCapabilityPreview(store, first.id, { acceptedBy: 'reviewer', rationale: 'first' });

    const changed = persistCapabilityPreview(store, 'batch:changed', {
      ...preview('changed text', 'delta:reuse'),
      baseDigest: previewCapabilityProjection(currentCapabilityStatements(store), [], new Map()).baseDigest,
    });

    expect(() => applyCapabilityPreview(store, changed.id, { acceptedBy: 'reviewer', rationale: 'changed' })).toThrow(/different content/);
  });

  test('rollback preview appends a version and leaves previous history bytes unchanged', () => {
    const first = persistCapabilityPreview(store, 'batch:first', preview('first text', 'delta:first'));
    const firstApply = applyCapabilityPreview(store, first.id, { acceptedBy: 'reviewer', rationale: 'first' });
    store.raw().run(
      `UPDATE capability_statements
       SET source_card_id = 'card:story', source_criterion_id = 'criterion:c-1', source_scope_revision = 1,
           evidence_id = 'evidence:ev-1', delivery_id = 'delivery:dl-1'
       WHERE projection_version_id = ?`,
      [firstApply.versionId],
    );
    const beforeRows = store.raw().query('SELECT * FROM capability_statements WHERE projection_version_id = ?').all(firstApply.versionId);

    const second = persistCapabilityPreview(store, 'batch:second', {
      ...preview('second text', 'delta:second'),
      baseDigest: previewCapabilityProjection(currentCapabilityStatements(store), [], new Map()).baseDigest,
    });
    applyCapabilityPreview(store, second.id, { acceptedBy: 'reviewer', rationale: 'second' });

    const rollback = previewCapabilityRollback(store, 'batch:rollback', firstApply.versionId);
    expect(rollback.preview.changes).toMatchObject([{ op: 'modify', before: 'second text', after: 'first text' }]);
    const appliedRollback = applyCapabilityPreview(store, rollback.id, { acceptedBy: 'reviewer', rationale: 'restore first' });

    expect(appliedRollback.version).toBe(3);
    expect(currentCapabilityStatements(store)).toMatchObject([{ text: 'first text' }]);
    expect(store.raw().query('SELECT * FROM capability_statements WHERE projection_version_id = ?').all(firstApply.versionId)).toEqual(beforeRows);
    expect(readCurrentCapabilityStatementStatus(store, new Map([['card:story:criterion:c-1', 2]]))).toMatchObject([
      { text: 'first text', evidenceId: 'evidence:ev-1', deliveryId: 'delivery:dl-1', sourceDrift: 'changed' },
    ]);
  });
});

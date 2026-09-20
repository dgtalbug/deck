import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { criterionTextDigest, validateCapabilityDeltas } from '../../../src/core/board/capability-deltas.ts';
import { readCapabilityEligibility, type ProjectionEligibility, type ProjectionSourceRecord } from '../../../src/core/board/capability-eligibility.ts';
import {
  applyCapabilityPreview,
  currentCapabilityStatements,
  persistCapabilityPreview,
  previewCapabilityProjection,
  readCurrentCapabilityStatementStatus,
} from '../../../src/core/board/capability-projection.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { tmpProject } from '../../helpers.ts';

let store: DocumentStore;
let cleanup: () => void;

beforeEach(async () => {
  const project = tmpProject('deck-capability-legacy-');
  cleanup = project.cleanup;
  store = await openStore(project.path);
});

afterEach(() => {
  cleanup();
});

function source(overrides: Partial<ProjectionSourceRecord> = {}): ProjectionSourceRecord {
  return {
    cardId: 'card:historical',
    criterionId: 'criterion:c-1',
    requestedScopeRevision: 3,
    currentScopeRevision: 3,
    currentLane: 'done',
    scopeDigest: 'a'.repeat(64),
    policyVersion: 2,
    evidence: {
      id: 'evidence:legacy',
      result: 'passed',
      scopeRevision: 3,
      policyVersion: 2,
      inputFingerprint: 'input:legacy',
    },
    delivery: {
      id: 'delivery:legacy',
      state: 'delivered',
      mode: 'solo',
      provenance: 'local',
      scopeRevision: 3,
      policyVersion: 2,
      inputFingerprint: 'input:legacy',
    },
    completion: {
      id: 'completion:legacy',
      acceptedRevision: 3,
      inputFingerprint: 'input:legacy',
    },
    ...overrides,
  };
}

function delta(text: string) {
  return validateCapabilityDeltas({
    batchId: 'batch:legacy',
    deltas: [{
      op: 'add',
      deltaId: 'delta:legacy',
      capabilityId: 'capability:legacy',
      statementId: 'statement:historical',
      statementText: text,
      source: {
        cardId: 'card:historical',
        criterionId: 'criterion:c-1',
        scopeRevision: 3,
        criterionDigest: criterionTextDigest(text),
        evidenceId: 'evidence:legacy',
        deliveryId: 'delivery:legacy',
      },
    }],
  }, [{ cardId: 'card:historical', criterionId: 'criterion:c-1', scopeRevision: 3, criterionText: text }]).deltas;
}

describe('capability legacy backfill fixtures', () => {
  test('missing historical completion proof cannot be waived by backfill preview', () => {
    const eligibility = readCapabilityEligibility(source({ evidence: null, delivery: null }));
    const preview = previewCapabilityProjection([], delta('Legacy source-backed capability.'), new Map([
      ['delta:legacy', eligibility],
    ]));

    expect(eligibility.status).toBe('ineligible');
    expect(preview.changes).toEqual([]);
    expect(preview.conflicts).toEqual([{ deltaId: 'delta:legacy', reason: 'source is ineligible' }]);
  });

  test('done-lane legacy work without Phase 4 completion proof is unknown, never eligible', () => {
    const eligibility = readCapabilityEligibility(source({ completion: null }));

    expect(eligibility.status).toBe('unknown');
    expect(eligibility.reasons).toContain('Phase 4 completion proof is missing — historical or legacy work cannot be treated as current capability truth');
    const preview = previewCapabilityProjection([], delta('Legacy source-backed capability.'), new Map([
      ['delta:legacy', eligibility],
    ]));
    expect(preview.changes).toEqual([]);
    expect(preview.conflicts).toEqual([{ deltaId: 'delta:legacy', reason: 'source is unknown' }]);
  });

  test('accepted historical deltas use the same transaction and lineage contracts', () => {
    const eligibility: ProjectionEligibility = readCapabilityEligibility(source());
    const preview = previewCapabilityProjection([], delta('Legacy source-backed capability.'), new Map([
      ['delta:legacy', eligibility],
    ]));
    const stored = persistCapabilityPreview(store, 'batch:legacy', preview);
    const applied = applyCapabilityPreview(store, stored.id, { acceptedBy: 'reviewer', rationale: 'legacy backfill accepted' });

    expect(applied).toMatchObject({ version: 1, reused: false });
    expect(currentCapabilityStatements(store)).toMatchObject([{
      capabilityId: 'capability:legacy',
      statementId: 'statement:historical',
      text: 'Legacy source-backed capability.',
      sourceCardId: 'card:historical',
      sourceCriterionId: 'criterion:c-1',
      sourceScopeRevision: 3,
      evidenceId: 'evidence:legacy',
      deliveryId: 'delivery:legacy',
    }]);
    expect(store.raw().query('SELECT delta_id AS deltaId, preview_id AS previewId, applied_version_id AS appliedVersionId FROM capability_deltas').all()).toEqual([
      { deltaId: 'delta:legacy', previewId: stored.id, appliedVersionId: applied.versionId },
    ]);
    expect(readCurrentCapabilityStatementStatus(store, new Map([['card:historical:criterion:c-1', 3]]))).toMatchObject([
      { sourceDrift: 'none', evidenceId: 'evidence:legacy', deliveryId: 'delivery:legacy' },
    ]);
  });
});

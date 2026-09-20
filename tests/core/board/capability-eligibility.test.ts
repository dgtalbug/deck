import { describe, expect, test } from 'bun:test';
import {
  readCapabilityEligibility,
  type ProjectionSourceRecord,
} from '../../../src/core/board/capability-eligibility.ts';

function source(overrides: Partial<ProjectionSourceRecord> = {}): ProjectionSourceRecord {
  return {
    cardId: 'card:story-1',
    criterionId: 'criterion:c-1',
    requestedScopeRevision: 2,
    currentScopeRevision: 2,
    currentLane: 'done',
    scopeDigest: 'a'.repeat(64),
    policyVersion: 3,
    evidence: {
      id: 'evidence:ev-1',
      result: 'passed',
      scopeRevision: 2,
      policyVersion: 3,
      inputFingerprint: 'b'.repeat(64),
    },
    delivery: {
      id: 'delivery:dl-1',
      state: 'delivered',
      mode: 'team',
      provenance: 'hosted',
      scopeRevision: 2,
      policyVersion: 3,
      inputFingerprint: 'b'.repeat(64),
    },
    completion: {
      id: 'completion:cp-1',
      acceptedRevision: 2,
      inputFingerprint: 'b'.repeat(64),
    },
    ...overrides,
  };
}

describe('capability projection eligibility', () => {
  test('accepts team and solo proof while preserving assurance', () => {
    expect(readCapabilityEligibility(source())).toMatchObject({ status: 'eligible', assurance: 'hosted' });
    expect(readCapabilityEligibility(source({
      delivery: { ...source().delivery!, mode: 'solo', provenance: 'local' },
    }))).toMatchObject({ status: 'eligible', assurance: 'local' });
  });

  test('uses the original recorded policy version rather than a later assumption', () => {
    const result = readCapabilityEligibility(source({
      evidence: { ...source().evidence!, policyVersion: 4 },
    }));

    expect(result.status).toBe('ineligible');
    expect(result.reasons).toContain('evidence policy version does not match original policy');
  });

  test('legacy unknowns and unavailable exact scope fail closed', () => {
    const result = readCapabilityEligibility(source({
      currentScopeRevision: null,
      scopeDigest: null,
      policyVersion: null,
      evidence: null,
      delivery: null,
    }));

    expect(result.status).toBe('unknown');
    expect(result.reasons).toContain('exact source scope revision is unavailable');
    expect(result.reasons).toContain('original delivery policy version is unavailable');
  });

  test('reopened or changed work cannot be projected as current truth', () => {
    expect(readCapabilityEligibility(source({ currentLane: 'active' }))).toMatchObject({
      status: 'ineligible',
      sourceDrift: 'reopened',
    });
    expect(readCapabilityEligibility(source({ currentScopeRevision: 3 }))).toMatchObject({
      status: 'ineligible',
      sourceDrift: 'changed',
    });
  });

  test('done lane alone is not enough without matching evidence and delivery', () => {
    const result = readCapabilityEligibility(source({ evidence: null }));

    expect(result.status).toBe('ineligible');
    expect(result.reasons).toContain('attributable evidence is missing');
  });

  test('legacy done work without completion proof is unknown, never inferred', () => {
    const result = readCapabilityEligibility(source({ completion: null }));

    expect(result.status).toBe('unknown');
    expect(result.reasons).toContain('Phase 4 completion proof is missing — historical or legacy work cannot be treated as current capability truth');
  });

  test('completion proof that predates the current scope is ineligible', () => {
    const result = readCapabilityEligibility(source({ completion: { id: 'completion:cp-0', acceptedRevision: 1, inputFingerprint: 'b'.repeat(64) } }));

    expect(result.status).toBe('ineligible');
    expect(result.reasons).toContain('completion proof predates the current accepted scope revision');
  });
});

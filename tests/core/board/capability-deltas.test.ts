import { describe, expect, test } from 'bun:test';
import { DeckError } from '../../../src/core/board/errors.ts';
import {
  criterionTextDigest,
  validateCapabilityDeltas,
  type CapabilityDeltaSource,
} from '../../../src/core/board/capability-deltas.ts';

const source: CapabilityDeltaSource = {
  cardId: 'card:story-1',
  criterionId: 'criterion:c-1',
  scopeRevision: 2,
  criterionText: 'Evidence bundles preserve source lineage.',
};

function addDelta(overrides: Record<string, unknown> = {}) {
  return {
    op: 'add',
    deltaId: 'delta:add-lineage',
    capabilityId: 'capability:evidence-bundle',
    statementId: 'statement:lineage',
    statementText: source.criterionText,
    source: {
      cardId: source.cardId,
      criterionId: source.criterionId,
      scopeRevision: source.scopeRevision,
      criterionDigest: criterionTextDigest(source.criterionText),
      evidenceId: 'evidence:ev-1',
      deliveryId: 'delivery:dl-1',
    },
    ...overrides,
  };
}

describe('capability delta validation', () => {
  test('accepts explicit add, modify and remove operations with stable identities', () => {
    const parsed = validateCapabilityDeltas({
      batchId: 'batch:one',
      deltas: [
        addDelta(),
        {
          ...addDelta({ op: 'modify', deltaId: 'delta:modify-lineage', expectedPriorDigest: 'a'.repeat(64) }),
        },
        {
          ...addDelta({ op: 'remove', deltaId: 'delta:remove-lineage', expectedPriorDigest: 'b'.repeat(64) }),
          statementText: undefined,
        },
      ],
    }, [source]);

    expect(parsed.deltas.map((delta) => delta.op)).toEqual(['add', 'modify', 'remove']);
  });

  test('rejects unstable IDs and invalid references', () => {
    expect(() => validateCapabilityDeltas({ batchId: '../x', deltas: [addDelta()] }, [source])).toThrow();
    expect(() => validateCapabilityDeltas({ batchId: 'batch:one', deltas: [addDelta()] }, [])).toThrow(DeckError);
  });

  test('refuses unsourced statement text and source digest drift', () => {
    expect(() =>
      validateCapabilityDeltas({
        batchId: 'batch:one',
        deltas: [addDelta({ statementText: 'A broader paraphrase.' })],
      }, [source]),
    ).toThrow(/must exactly match/);

    expect(() =>
      validateCapabilityDeltas({
        batchId: 'batch:one',
        deltas: [addDelta({ source: { ...addDelta().source, criterionDigest: 'c'.repeat(64) } })],
      }, [source]),
    ).toThrow(/digest does not match/);
  });

  test('rejects duplicate delta identities', () => {
    expect(() =>
      validateCapabilityDeltas({
        batchId: 'batch:one',
        deltas: [addDelta(), addDelta()],
      }, [source]),
    ).toThrow(/duplicate capability delta id/);
  });
});

import { describe, expect, test } from 'bun:test';
import { criterionTextDigest, validateCapabilityDeltas } from '../../../src/core/board/capability-deltas.ts';
import { capabilityStatementDigest, previewCapabilityProjection } from '../../../src/core/board/capability-projection.ts';
import type { ProjectionEligibility } from '../../../src/core/board/capability-eligibility.ts';

const eligible: ProjectionEligibility = {
  status: 'eligible',
  assurance: 'hosted',
  evidenceId: 'evidence:ev-1',
  deliveryId: 'delivery:dl-1',
  reasons: [],
  sourceDrift: 'none',
};

function delta(text: string, op: 'add' | 'modify' | 'remove' = 'add', id = `delta:${op}`) {
  const base = {
    op,
    deltaId: id,
    capabilityId: 'capability:evidence',
    statementId: 'statement:lineage',
    source: {
      cardId: 'card:story',
      criterionId: 'criterion:c-1',
      scopeRevision: 1,
      criterionDigest: criterionTextDigest(text),
      evidenceId: 'evidence:ev-1',
      deliveryId: 'delivery:dl-1',
    },
  };
  return op === 'add'
    ? { ...base, statementText: text }
    : op === 'modify'
      ? { ...base, expectedPriorDigest: capabilityStatementDigest('old text'), statementText: text }
      : { ...base, expectedPriorDigest: capabilityStatementDigest('old text') };
}

describe('capability projection preview', () => {
  test('applies compatible ordered add, modify and remove deltas', () => {
    const modify = validateCapabilityDeltas({ batchId: 'batch:one', deltas: [delta('new text', 'modify')] }, [
      { cardId: 'card:story', criterionId: 'criterion:c-1', scopeRevision: 1, criterionText: 'new text' },
    ]).deltas[0]!;
    const remove = validateCapabilityDeltas({ batchId: 'batch:two', deltas: [{
      ...delta('ignored source text', 'remove'),
      expectedPriorDigest: capabilityStatementDigest('new text'),
    }] }, [
      { cardId: 'card:story', criterionId: 'criterion:c-1', scopeRevision: 1, criterionText: 'ignored source text' },
    ]).deltas[0]!;

    const first = previewCapabilityProjection([], validateCapabilityDeltas({ batchId: 'batch:add', deltas: [delta('old text')] }, [
      { cardId: 'card:story', criterionId: 'criterion:c-1', scopeRevision: 1, criterionText: 'old text' },
    ]).deltas, new Map([['delta:add', eligible]]));
    const second = previewCapabilityProjection(first.statements, [modify, remove], new Map([
      ['delta:modify', eligible],
      ['delta:remove', eligible],
    ]));

    expect(first.conflicts).toEqual([]);
    expect(second.changes.map((change) => change.op)).toEqual(['modify', 'remove']);
    expect(second.statements[0]!.state).toBe('removed');
  });

  test('detects duplicate add, absent removal and prior digest mismatch', () => {
    const current = [{
      capabilityId: 'capability:evidence',
      statementId: 'statement:lineage',
      text: 'old text',
      digest: capabilityStatementDigest('old text'),
      state: 'current' as const,
    }];

    expect(previewCapabilityProjection(current, validateCapabilityDeltas({ batchId: 'batch:add', deltas: [delta('old text')] }, [
      { cardId: 'card:story', criterionId: 'criterion:c-1', scopeRevision: 1, criterionText: 'old text' },
    ]).deltas, new Map([['delta:add', eligible]])).conflicts[0]!.reason).toContain('existing current');

    expect(previewCapabilityProjection([], validateCapabilityDeltas({ batchId: 'batch:remove', deltas: [delta('old text', 'remove')] }, [
      { cardId: 'card:story', criterionId: 'criterion:c-1', scopeRevision: 1, criterionText: 'old text' },
    ]).deltas, new Map([['delta:remove', eligible]])).conflicts[0]!.reason).toContain('absent current');

    const bad = { ...delta('new text', 'modify'), expectedPriorDigest: 'a'.repeat(64) };
    const parsed = validateCapabilityDeltas({ batchId: 'batch:bad', deltas: [bad] }, [
      { cardId: 'card:story', criterionId: 'criterion:c-1', scopeRevision: 1, criterionText: 'new text' },
    ]).deltas;
    expect(previewCapabilityProjection(current, parsed, new Map([['delta:modify', eligible]])).conflicts[0]!.reason).toContain('prior digest');
  });

  test('competing statement changes stop without semantic merging', () => {
    const first = validateCapabilityDeltas({ batchId: 'batch:first', deltas: [delta('new text', 'modify', 'delta:first')] }, [
      { cardId: 'card:story', criterionId: 'criterion:c-1', scopeRevision: 1, criterionText: 'new text' },
    ]).deltas[0]!;
    const second = validateCapabilityDeltas({ batchId: 'batch:second', deltas: [delta('other text', 'modify', 'delta:second')] }, [
      { cardId: 'card:story', criterionId: 'criterion:c-1', scopeRevision: 1, criterionText: 'other text' },
    ]).deltas[0]!;
    const preview = previewCapabilityProjection([{
      capabilityId: 'capability:evidence',
      statementId: 'statement:lineage',
      text: 'old text',
      digest: capabilityStatementDigest('old text'),
      state: 'current',
    }], [first, second], new Map([
      ['delta:first', eligible],
      ['delta:second', eligible],
    ]));

    expect(preview.changes).toHaveLength(1);
    expect(preview.conflicts).toEqual([{ deltaId: 'delta:second', reason: 'expected prior digest does not match current statement' }]);
  });
});

import { describe, expect, test } from 'bun:test';
import { comparePaired, type ComparisonInput } from '../../scripts/evaluation/compare.ts';
import { scoreAttempt } from '../../scripts/evaluation/score.ts';
import { samePinnedComparison, validateManifest, type EvaluationAttempt } from '../../scripts/evaluation/schema.ts';

const references = ['src/a.ts:one', 'src/a.ts:two', 'src/b.ts:three'];

function attempt(id: string, strategy: 'baseline' | 'candidate', overrides: Record<string, unknown> = {}): EvaluationAttempt {
  return {
    id, strategy, scenario: `scenario-${id}`, status: 'completed',
    accounting: { inputTokens: 100, outputTokens: 100, totalTokens: 200, wallTimeMs: 1_000, toolCalls: 1, spend: 0.01 },
    interventions: 0, criticalViolations: 0, criticalOmissions: 0, usefulReferences: 0, taskSuccess: true,
    ...overrides,
  };
}

function pairs(baselineUseful: number, candidateUseful: number, candidateOverrides: Record<string, unknown> = {}): ComparisonInput[] {
  const inputs: ComparisonInput[] = [];
  for (let i = 0; i < 5; i++) {
    inputs.push({
      attempt: attempt(`b-${i}`, 'baseline'),
      relevant: new Set(references),
      returned: references.slice(0, baselineUseful),
      kind: 'live',
    });
    inputs.push({
      attempt: attempt(`c-${i}`, 'candidate', candidateOverrides),
      relevant: new Set(references),
      returned: references.slice(0, candidateUseful),
      kind: 'live',
    });
  }
  return inputs;
}

describe('paired comparison', () => {
  test('promotes a candidate that improves recall at equal everything else', () => {
    const result = comparePaired(pairs(1, 3));
    expect(result.eligible).toBe(true);
    expect(result.promoted).toBe(true);
    expect(result.reason).toEqual([]);
  });

  test('favorable retrieval with critical violations fails promotion', () => {
    const result = comparePaired(pairs(1, 3, { criticalViolations: 1 }));
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain('candidate has critical violations');
  });

  test('empty results cannot inflate precision — the denominator stays 10', () => {
    const score = scoreAttempt(attempt('x', 'baseline'), new Set(references), []);
    expect(score.precisionAt10).toBe(0);
    expect(score.recallAt10).toBe(0);
  });

  test('fewer than five paired live attempts per strategy is not eligible', () => {
    const inputs = pairs(1, 3).slice(0, 6);
    const result = comparePaired(inputs);
    expect(result.eligible).toBe(false);
    expect(result.promoted).toBe(false);
    expect(result.reason.some((r) => r.includes('completed live attempts per strategy are required'))).toBe(true);
  });

  test('equal declared budgets are part of the frozen comparison identity', () => {
    const ceilings = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, wallTimeMs: 60_000, toolCalls: 10, spend: 1 };
    const base = { protocolVersion: 'v1', manifestHash: 'h', kind: 'live', host: { name: 'h', version: '1' }, model: { name: 'm', version: '1' }, tokenizer: { name: 't', version: '1' }, scenarioRevision: 's', sourceRevision: 'r', skillVersion: '1', promptHash: 'p', toolHash: 't', permissions: [], ceilings, pairedScenarios: ['a'], attempts: [] };
    const a = validateManifest(base);
    const b = validateManifest({ ...base, ceilings: { ...ceilings, totalTokens: 1_200 } });
    expect(samePinnedComparison(a, b)).toBe(false);
  });

  test('a negative outcome keeps the candidate experimental', () => {
    const result = comparePaired(pairs(3, 1));
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain('candidate recall must strictly improve');
  });

  test('replayed attempts are excluded and break eligibility for the live sample', () => {
    const inputs = pairs(1, 3).map((input, index) => (index === 0 ? { ...input, kind: 'replay' as const } : input));
    const result = comparePaired(inputs);
    expect(result.eligible).toBe(false);
    expect(result.reason.some((r) => r.includes('replayed attempts excluded'))).toBe(true);
  });
});

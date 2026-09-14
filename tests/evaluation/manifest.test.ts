import { describe, expect, test } from 'bun:test';
import {
  promotionEligible,
  samePinnedComparison,
  validateManifest,
  type EvaluationManifest,
} from '../../scripts/evaluation/schema.ts';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 'context-evaluation-v1',
    manifestHash: 'hash-1',
    kind: 'live',
    host: { name: 'host-x', version: '1.0.0' },
    model: { name: 'model-x', version: '2026-09-01' },
    tokenizer: { name: 'tok-x', version: '1' },
    scenarioRevision: 'scen-1',
    sourceRevision: 'src-1',
    skillVersion: '1.0.0',
    promptHash: 'p-1',
    toolHash: 't-1',
    permissions: ['fs:repo'],
    ceilings: { inputTokens: 100_000, outputTokens: 10_000, totalTokens: 110_000, wallTimeMs: 600_000, toolCalls: 100, spend: 5 },
    pairedScenarios: ['resume', 'stale-checkpoint', 'refusal', 'review', 'relevant-source-change'],
    attempts: [
      {
        id: 'a-1', strategy: 'baseline', scenario: 'resume', status: 'completed',
        accounting: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, wallTimeMs: 10_000, toolCalls: 5, spend: 0.1 },
        interventions: 0, criticalViolations: 0, criticalOmissions: 0, usefulReferences: 3, taskSuccess: true,
      },
    ],
    ...overrides,
  };
}

describe('evaluation manifest validation', () => {
  test('accepts a complete live manifest', () => {
    expect(() => validateManifest(manifest())).not.toThrow();
  });

  test('rejects a live attempt without usable accounting', () => {
    const input = manifest({
      attempts: [{
        id: 'a-2', strategy: 'candidate', scenario: 'resume', status: 'completed', accounting: null,
        interventions: 0, criticalViolations: 0, criticalOmissions: 0, usefulReferences: 0, taskSuccess: true,
      }],
    });
    expect(() => validateManifest(input)).toThrow(/live attempts require usable accounting/);
  });

  test('allows missing accounting only for replay runs', () => {
    const attempt = {
      id: 'a-3', strategy: 'baseline', scenario: 'resume', status: 'completed', accounting: null,
      interventions: 0, criticalViolations: 0, criticalOmissions: 0, usefulReferences: 0, taskSuccess: false,
    };
    expect(() => validateManifest(manifest({ kind: 'replay', attempts: [attempt] }))).not.toThrow();
    expect(() => validateManifest(manifest({ attempts: [attempt] }))).toThrow();
  });

  test('detects model drift between an attempt receipt and the manifest pin', () => {
    const attempt = {
      id: 'a-4', strategy: 'candidate', scenario: 'review', status: 'completed',
      accounting: { inputTokens: 10, outputTokens: 10, totalTokens: 20, wallTimeMs: 100, toolCalls: 1, spend: 0 },
      interventions: 0, criticalViolations: 0, criticalOmissions: 0, usefulReferences: 0, taskSuccess: true,
      receipt: { host: { name: 'host-x', version: '1.0.0' }, model: { name: 'model-x', version: '2026-08-01' }, tokenizer: { name: 'tok-x', version: '1' } },
    };
    expect(() => validateManifest(manifest({ attempts: [attempt] }))).toThrow(/receipt identity drifted/);
  });

  test('retains a ceiling breach as a budget failure instead of rejecting it', () => {
    const over = {
      id: 'a-5', strategy: 'baseline', scenario: 'refusal', status: 'budget-failure',
      accounting: { inputTokens: 200_000, outputTokens: 20_000, totalTokens: 220_000, wallTimeMs: 700_000, toolCalls: 150, spend: 9 },
      interventions: 1, criticalViolations: 0, criticalOmissions: 0, usefulReferences: 0, taskSuccess: false,
    };
    expect(() => validateManifest(manifest({ attempts: [over] }))).not.toThrow();
  });

  test('rejects a completed attempt that silently exceeded its ceilings', () => {
    const over = {
      id: 'a-6', strategy: 'candidate', scenario: 'refusal', status: 'completed',
      accounting: { inputTokens: 200_000, outputTokens: 20_000, totalTokens: 220_000, wallTimeMs: 10_000, toolCalls: 5, spend: 0.1 },
      interventions: 0, criticalViolations: 0, criticalOmissions: 0, usefulReferences: 0, taskSuccess: true,
    };
    expect(() => validateManifest(manifest({ attempts: [over] }))).toThrow(/not recorded as a budget failure/);
  });

  test('a replay manifest is never promotion-eligible even with full accounting', () => {
    const live = validateManifest(manifest());
    const replay = validateManifest(manifest({ kind: 'replay', manifestHash: 'hash-2' }));
    expect(promotionEligible(live)).toBe(true);
    expect(promotionEligible(replay)).toBe(false);
  });

  test('any frozen input change defines a new comparison', () => {
    const base = validateManifest(manifest()) as EvaluationManifest;
    const driftedModel = validateManifest(manifest({ model: { name: 'model-x', version: '2026-09-02' } })) as EvaluationManifest;
    const driftedBudget = validateManifest(manifest({
      ceilings: { inputTokens: 90_000, outputTokens: 10_000, totalTokens: 100_000, wallTimeMs: 600_000, toolCalls: 100, spend: 5 },
    })) as EvaluationManifest;
    const same = validateManifest(manifest({ attempts: [] })) as EvaluationManifest;
    expect(samePinnedComparison(base, same)).toBe(true);
    expect(samePinnedComparison(base, driftedModel)).toBe(false);
    expect(samePinnedComparison(base, driftedBudget)).toBe(false);
  });
});

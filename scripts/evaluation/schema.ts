import { z } from 'zod';

export const runKind = z.enum(['live', 'replay']);
export const attemptStatus = z.enum(['completed', 'failed', 'cancelled', 'invalid', 'budget-failure']);

const identity = z.object({ name: z.string().min(1), version: z.string().min(1) });
const ceilings = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative(), wallTimeMs: z.number().int().positive(), toolCalls: z.number().int().nonnegative(), spend: z.number().nonnegative() });
const accounting = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative(), wallTimeMs: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(), spend: z.number().nonnegative() }).nullable();

// A receipt captures the resolved host/model/tokenizer identities the attempt
// actually ran with; when present it must match the manifest pin so drift
// between arms cannot pass as a paired comparison.
const receipt = z.object({ host: identity, model: identity, tokenizer: identity });

export const attemptSchema = z.object({
  id: z.string().min(1), strategy: z.enum(['baseline', 'candidate']), scenario: z.string().min(1),
  status: attemptStatus, accounting, interventions: z.number().int().nonnegative(),
  criticalViolations: z.number().int().nonnegative(), criticalOmissions: z.number().int().nonnegative(),
  usefulReferences: z.number().int().nonnegative(), taskSuccess: z.boolean(),
  receipt: receipt.optional(),
});

export const manifestSchema = z.object({
  protocolVersion: z.string().min(1), manifestHash: z.string().min(1), kind: runKind,
  host: identity, model: identity, tokenizer: identity, scenarioRevision: z.string().min(1),
  sourceRevision: z.string().min(1), skillVersion: z.string().min(1), promptHash: z.string().min(1), toolHash: z.string().min(1),
  permissions: z.array(z.string()), ceilings, pairedScenarios: z.array(z.string()).min(1), attempts: z.array(attemptSchema),
}).superRefine((value, ctx) => {
  if (value.kind === 'live' && value.attempts.some((a) => a.accounting === null)) {
    ctx.addIssue({ code: 'custom', path: ['attempts'], message: 'live attempts require usable accounting' });
  }
  for (const attempt of value.attempts) {
    const drift = attempt.receipt !== undefined && (attempt.receipt.model.version !== value.model.version || attempt.receipt.host.version !== value.host.version || attempt.receipt.tokenizer.version !== value.tokenizer.version);
    if (drift) ctx.addIssue({ code: 'custom', path: ['attempts'], message: `attempt ${attempt.id} receipt identity drifted from the manifest pin` });
    const over = attempt.accounting !== null && exceedsCeilings(attempt.accounting, value.ceilings);
    if (over && attempt.status !== 'budget-failure') {
      ctx.addIssue({ code: 'custom', path: ['attempts'], message: `attempt ${attempt.id} exceeds declared ceilings but is not recorded as a budget failure` });
    }
  }
});

export type EvaluationManifest = z.infer<typeof manifestSchema>;
export type EvaluationAttempt = z.infer<typeof attemptSchema>;
export type Ceilings = z.infer<typeof ceilings>;
export type Accounting = NonNullable<EvaluationAttempt['accounting']>;

export function exceedsCeilings(usage: Accounting, limits: Ceilings): boolean {
  return usage.inputTokens > limits.inputTokens || usage.outputTokens > limits.outputTokens ||
    usage.totalTokens > limits.totalTokens || usage.wallTimeMs > limits.wallTimeMs ||
    usage.toolCalls > limits.toolCalls || usage.spend > limits.spend;
}

export function validateManifest(input: unknown): EvaluationManifest { return manifestSchema.parse(input); }

// Promotion-eligible evidence must come from actual live execution with
// usable accounting on every attempt; replays and invalid manifests stay in
// reports but never count toward the live sample.
export function promotionEligible(manifest: EvaluationManifest): boolean {
  if (manifest.kind !== 'live') return false;
  return manifest.attempts.every((attempt) => attempt.accounting !== null);
}

// Two manifests describe the same pinned comparison only when every input the
// protocol freezes matches; any change defines a new experiment.
export function samePinnedComparison(a: EvaluationManifest, b: EvaluationManifest): boolean {
  return a.protocolVersion === b.protocolVersion && a.manifestHash === b.manifestHash &&
    a.host.version === b.host.version && a.model.version === b.model.version &&
    a.tokenizer.version === b.tokenizer.version && a.skillVersion === b.skillVersion &&
    a.promptHash === b.promptHash && a.toolHash === b.toolHash &&
    JSON.stringify(a.permissions) === JSON.stringify(b.permissions) &&
    JSON.stringify(a.ceilings) === JSON.stringify(b.ceilings);
}

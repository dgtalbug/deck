import type { EvaluationAttempt } from './schema.ts';
import { scoreAttempt, type Score } from './score.ts';

export interface ComparisonInput {
  attempt: EvaluationAttempt;
  relevant: Set<string>;
  returned: string[];
  kind: 'live' | 'replay';
}

export interface Comparison {
  eligible: boolean;
  promoted: boolean;
  reason: string[];
  baseline: Score[];
  candidate: Score[];
}

const MINIMUM_PAIRS = 5;

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((total, value) => total + value, 0) / xs.length;
}

// Frozen pilot rule: equal budgets, zero
// candidate critical violations, no increase in critical omissions or
// interventions, strictly improved mean recall@10, and mean precision@10 plus
// task-success rate no lower than baseline. These are engineering gates for
// this pilot, not statistical claims.
export function comparePaired(inputs: ComparisonInput[]): Comparison {
  const live = inputs.filter((input) => input.kind === 'live');
  const replays = inputs.length - live.length;
  const baseline = live.filter((x) => x.attempt.strategy === 'baseline' && x.attempt.status === 'completed').map((x) => scoreAttempt(x.attempt, x.relevant, x.returned));
  const candidate = live.filter((x) => x.attempt.strategy === 'candidate' && x.attempt.status === 'completed').map((x) => scoreAttempt(x.attempt, x.relevant, x.returned));
  const reason: string[] = [];

  if (replays > 0) reason.push(`${replays} replayed attempts excluded from the live sample`);
  if (baseline.length < MINIMUM_PAIRS || candidate.length < MINIMUM_PAIRS) {
    reason.push(`at least ${MINIMUM_PAIRS} completed live attempts per strategy are required (have baseline=${baseline.length}, candidate=${candidate.length})`);
  }
  if (candidate.some((x) => x.criticalViolations > 0)) reason.push('candidate has critical violations');
  if (mean(candidate.map((x) => x.criticalOmissions)) > mean(baseline.map((x) => x.criticalOmissions))) {
    reason.push('candidate critical omissions increased');
  }
  if (mean(candidate.map((x) => x.recallAt10)) <= mean(baseline.map((x) => x.recallAt10))) reason.push('candidate recall must strictly improve');
  if (mean(candidate.map((x) => x.precisionAt10)) < mean(baseline.map((x) => x.precisionAt10))) reason.push('candidate precision decreased');
  if (mean(candidate.map((x) => Number(x.taskSuccess))) < mean(baseline.map((x) => Number(x.taskSuccess)))) reason.push('candidate task success decreased');
  if (mean(candidate.map((x) => x.interventions)) > mean(baseline.map((x) => x.interventions))) reason.push('candidate interventions increased');

  const eligible = baseline.length >= MINIMUM_PAIRS && candidate.length >= MINIMUM_PAIRS && replays === 0;
  return { eligible, promoted: reason.length === 0, reason, baseline, candidate };
}

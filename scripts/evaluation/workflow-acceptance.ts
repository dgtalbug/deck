/**
 * Workflow-acceptance evidence model (T06 `add-agent-workflow-acceptance-tests`).
 *
 * Minimal, file-based companion to the context-evaluation schema: it classifies
 * retained scenario evidence so actual agent workflow runs can never be
 * confused with deterministic fixture coverage, backend bypasses, or blocked
 * attempts. It deliberately shares nothing with the E07 promotion machinery.
 */

export type WorkflowScenarioKind =
  | 'small-fix'
  | 'bounded-feature'
  | 'cross-cutting-feature'
  | 'ambiguity'
  | 'repeated-intake'
  | 'graph-grounded-planning'
  | 'interruption-resume';

export const WORKFLOW_SCENARIO_KINDS: readonly WorkflowScenarioKind[] = [
  'small-fix',
  'bounded-feature',
  'cross-cutting-feature',
  'ambiguity',
  'repeated-intake',
  'graph-grounded-planning',
  'interruption-resume',
];

export interface WorkflowScenario {
  id: string;
  kind: WorkflowScenarioKind;
  prompt: string;
  /** deck-* skills the scenario expects the agent to select and follow. */
  skillsExpected: string[];
  /** Facts that must be observable in the transcript or resulting card state. */
  requiredFacts: string[];
  /** Actions that invalidate the run if performed. */
  forbiddenActions: string[];
  /** Rubric criteria scored per attempt (PASS / FAIL / BLOCKED each). */
  rubric: string[];
}

/** How a retained attempt counts as evidence. */
export type EvidenceClass =
  | 'agent-workflow'   // live run where the agent selected and followed the skill
  | 'deterministic'    // CLI/unit/fixture coverage only
  | 'backend-bypass';  // raw CLI/API/MCP calls that never loaded the skill

export interface WorkflowAttempt {
  scenarioId: string;
  evidenceClass: EvidenceClass;
  host: { name: string; model: string };
  setup: {
    deckHome: 'isolated-tmp';
    port: number;
    project: string;
    binary: string;
    skillsSource: string;
  };
  skillsLoaded: string[];
  transcriptPath: string;
  resultingCardState: Record<string, unknown>;
  /** Concrete limits that prevented completion, if any. */
  environmentLimits: string[];
  /** Steps the evaluator supplied; never counted as agent behavior. */
  evaluatorSuppliedSteps: string[];
  forbiddenActionsObserved: string[];
  rubric: Array<{ criterion: string; outcome: 'PASS' | 'FAIL' | 'BLOCKED' }>;
}

export function validateScenario(scenario: WorkflowScenario): string[] {
  const errors: string[] = [];
  if (scenario.id.length === 0) errors.push('scenario id is empty');
  if (!WORKFLOW_SCENARIO_KINDS.includes(scenario.kind)) errors.push(`${scenario.id}: unknown kind '${scenario.kind}'`);
  if (scenario.prompt.length === 0) errors.push(`${scenario.id}: empty prompt`);
  if (scenario.skillsExpected.length === 0) errors.push(`${scenario.id}: no expected skills`);
  if (scenario.rubric.length === 0) errors.push(`${scenario.id}: empty rubric`);
  return errors;
}

export function validateAttempt(attempt: WorkflowAttempt, scenarios: WorkflowScenario[]): string[] {
  const errors: string[] = [];
  const scenario = scenarios.find((entry) => entry.id === attempt.scenarioId);
  if (scenario === undefined) {
    return [`attempt references unknown scenario '${attempt.scenarioId}'`];
  }
  if (attempt.evidenceClass === 'agent-workflow') {
    if (attempt.host.name.length === 0 || attempt.host.model.length === 0) {
      errors.push(`${attempt.scenarioId}: agent-workflow evidence requires host and model`);
    }
    for (const skill of scenario.skillsExpected) {
      if (!attempt.skillsLoaded.includes(skill)) {
        errors.push(`${attempt.scenarioId}: agent-workflow evidence never loaded '${skill}'`);
      }
    }
    if (attempt.setup.deckHome !== 'isolated-tmp') {
      errors.push(`${attempt.scenarioId}: agent-workflow runs must use an isolated DECK_HOME`);
    }
  }
  const rubricNames = new Set(attempt.rubric.map((row) => row.criterion));
  for (const criterion of scenario.rubric) {
    if (!rubricNames.has(criterion)) {
      errors.push(`${attempt.scenarioId}: rubric is missing scored criterion '${criterion}'`);
    }
  }
  for (const row of attempt.rubric) {
    if (!scenario.rubric.includes(row.criterion)) {
      errors.push(`${attempt.scenarioId}: rubric scores unknown criterion '${row.criterion}'`);
    }
  }
  if (attempt.environmentLimits.length > 0 && attempt.rubric.some((row) => row.outcome === 'PASS')) {
    errors.push(`${attempt.scenarioId}: environment-limited attempt cannot carry PASS rubric rows`);
  }
  return errors;
}

export type ScenarioOutcome = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT-AGENT-EVIDENCE';

/**
 * The evidence law, in one function:
 * - only `agent-workflow` attempts can pass or fail a scenario;
 * - `deterministic` and `backend-bypass` attempts are supporting evidence and
 *   can never mark a scenario passed (or failed) as skill behavior;
 * - environment-limited attempts are BLOCKED, never promoted to PASS;
 * - any observed forbidden action fails the run outright.
 */
export function scenarioOutcome(attempt: WorkflowAttempt): ScenarioOutcome {
  if (attempt.evidenceClass !== 'agent-workflow') return 'NOT-AGENT-EVIDENCE';
  if (attempt.environmentLimits.length > 0) return 'BLOCKED';
  if (attempt.forbiddenActionsObserved.length > 0) return 'FAIL';
  if (attempt.rubric.some((row) => row.outcome === 'BLOCKED')) return 'BLOCKED';
  return attempt.rubric.every((row) => row.outcome === 'PASS') ? 'PASS' : 'FAIL';
}

/** Rubric criteria a scenario scores but the attempt left unproven. */
export function unprovenCriteria(attempt: WorkflowAttempt): string[] {
  return attempt.rubric
    .filter((row) => row.outcome !== 'PASS')
    .map((row) => `${row.criterion}=${row.outcome}`);
}

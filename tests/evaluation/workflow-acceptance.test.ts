import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  scenarioOutcome,
  unprovenCriteria,
  validateAttempt,
  validateScenario,
  WORKFLOW_SCENARIO_KINDS,
  type WorkflowAttempt,
  type WorkflowScenario,
} from '../../scripts/evaluation/workflow-acceptance.ts';
import scenarioFixtures from '../fixtures/context-evaluation/workflow/scenarios.json';

const scenarios = scenarioFixtures as unknown as WorkflowScenario[];

function attempt(overrides: Partial<WorkflowAttempt> = {}): WorkflowAttempt {
  return {
    scenarioId: 'wf-repeated-intake',
    evidenceClass: 'agent-workflow',
    host: { name: 'ZCode', model: 'GLM-5.3' },
    setup: {
      deckHome: 'isolated-tmp',
      port: 3399,
      project: 't06demo',
      binary: 'deck 0.6.0 (rebuilt 2026-09-19)',
      skillsSource: 'compiled skill pack (byte-parity with src/skills)',
    },
    skillsLoaded: ['deck-capture'],
    transcriptPath: 'evidence/transcript.txt',
    resultingCardState: {},
    environmentLimits: [],
    evaluatorSuppliedSteps: [],
    forbiddenActionsObserved: [],
    rubric: [
      { criterion: 'scan-before-create', outcome: 'PASS' },
      { criterion: 'one-decision-recorded', outcome: 'PASS' },
      { criterion: 'no-duplicate-created', outcome: 'PASS' },
      { criterion: 'card-identity-preserved', outcome: 'PASS' },
      { criterion: 'engine-doors-only', outcome: 'PASS' },
    ],
    ...overrides,
  };
}

describe('workflow-acceptance: scenario fixtures', () => {
  test('all seven scenario kinds are defined exactly once', () => {
    const kinds = scenarios.map((scenario) => scenario.kind).sort();
    expect(kinds).toEqual([...WORKFLOW_SCENARIO_KINDS].sort());
  });

  test('every scenario fixture validates', () => {
    for (const scenario of scenarios) {
      expect(validateScenario(scenario)).toEqual([]);
    }
  });

  test('every scenario names at least one expected skill and rubric criterion', () => {
    for (const scenario of scenarios) {
      expect(scenario.skillsExpected.length).toBeGreaterThan(0);
      expect(scenario.rubric.length).toBeGreaterThan(0);
      expect(scenario.forbiddenActions.length).toBeGreaterThan(0);
      expect(scenario.requiredFacts.length).toBeGreaterThan(0);
    }
  });
});

describe('workflow-acceptance: negative controls (fixture success cannot masquerade as agent behavior)', () => {
  test('a deterministic (CLI/fixture) attempt with an all-PASS rubric is NOT agent evidence', () => {
    const outcome = scenarioOutcome(attempt({ evidenceClass: 'deterministic' }));
    expect(outcome).toBe('NOT-AGENT-EVIDENCE');
  });

  test('a raw backend bypass that never loaded the skill is NOT skill evidence (neither pass nor fail)', () => {
    const bypass = attempt({
      evidenceClass: 'backend-bypass',
      skillsLoaded: [],
      resultingCardState: { duplicateCreated: true },
    });
    expect(scenarioOutcome(bypass)).toBe('NOT-AGENT-EVIDENCE');
  });

  test('an environment-limited attempt is BLOCKED and never promoted to PASS', () => {
    const blocked = attempt({
      environmentLimits: ['listener ports unavailable in sandbox'],
      rubric: [{ criterion: 'scan-before-create', outcome: 'BLOCKED' }],
    });
    expect(scenarioOutcome(blocked)).toBe('BLOCKED');
  });

  test('a single BLOCKED rubric row blocks the scenario even without environment limits', () => {
    const blocked = attempt({
      rubric: attempt().rubric.map((row, index) => (index === 0 ? { ...row, outcome: 'BLOCKED' } : row)),
    });
    expect(scenarioOutcome(blocked)).toBe('BLOCKED');
  });

  test('an observed forbidden action fails the run even when every rubric row passes', () => {
    const violation = attempt({ forbiddenActionsObserved: ['creating a second card for the retried request'] });
    expect(scenarioOutcome(violation)).toBe('FAIL');
  });

  test('a genuine agent-workflow run with all rubric criteria passing is the only PASS shape', () => {
    expect(scenarioOutcome(attempt())).toBe('PASS');
    const failing = attempt({
      rubric: attempt().rubric.map((row, index) => (index === 2 ? { ...row, outcome: 'FAIL' } : row)),
    });
    expect(scenarioOutcome(failing)).toBe('FAIL');
    expect(unprovenCriteria(failing)).toEqual(['no-duplicate-created=FAIL']);
  });
});

describe('workflow-acceptance: attempt validation against its scenario', () => {
  test('rejects an attempt referencing an unknown scenario', () => {
    const errors = validateAttempt(attempt({ scenarioId: 'wf-nope' }), scenarios);
    expect(errors).toEqual(["attempt references unknown scenario 'wf-nope'"]);
  });

  test('agent-workflow evidence must have loaded every expected skill', () => {
    const errors = validateAttempt(attempt({ skillsLoaded: [] }), scenarios);
    expect(errors).toEqual([`${attempt().scenarioId}: agent-workflow evidence never loaded 'deck-capture'`]);
  });

  test('agent-workflow evidence must record host and model', () => {
    const errors = validateAttempt(attempt({ host: { name: '', model: '' } }), scenarios);
    expect(errors[0]).toContain('requires host and model');
  });

  test('the rubric must score exactly the scenario criteria', () => {
    const partial = attempt({
      rubric: attempt().rubric.slice(0, 2).map((row) => ({ criterion: row.criterion, outcome: 'PASS' as const })),
    });
    const missing = validateAttempt(partial, scenarios);
    expect(missing).toHaveLength(3);
    for (const error of missing) expect(error).toContain('missing scored criterion');

    const invented = attempt({
      rubric: [...attempt().rubric, { criterion: 'vibes', outcome: 'PASS' as const }],
    });
    expect(validateAttempt(invented, scenarios)).toEqual([
      `${attempt().scenarioId}: rubric scores unknown criterion 'vibes'`,
    ]);
  });

  test('an environment-limited attempt cannot carry PASS rubric rows', () => {
    const errors = validateAttempt(attempt({ environmentLimits: ['provider unavailable'] }), scenarios);
    expect(errors).toEqual([`${attempt().scenarioId}: environment-limited attempt cannot carry PASS rubric rows`]);
  });

  test('deterministic attempts need neither host facts nor loaded skills (they stay supporting evidence)', () => {
    expect(
      validateAttempt(
        attempt({ evidenceClass: 'deterministic', host: { name: '', model: '' }, skillsLoaded: [] }),
        scenarios,
      ),
    ).toEqual([]);
  });
});

describe('workflow-acceptance: retained agent-run evidence stays consistent with the law', () => {
  const evidenceRoot = join(import.meta.dir, '..', '..', 'openspec', 'changes', 'add-agent-workflow-acceptance-tests', 'evidence');
  const manifest = JSON.parse(readFileSync(join(evidenceRoot, 'attempts.json'), 'utf8')) as {
    environment: WorkflowAttempt['setup'];
    attempts: WorkflowAttempt[];
  };
  // The manifest factors the shared setup into one environment block; hydrate
  // it into each attempt before validation.
  const retained = manifest.attempts.map((record) => ({ ...record, setup: manifest.environment }));

  test('every retained attempt validates against its scenario', () => {
    for (const record of retained) {
      expect(validateAttempt(record, scenarios)).toEqual([]);
    }
  });

  test('every retained agent-workflow attempt names a transcript that exists', () => {
    for (const record of retained) {
      if (record.evidenceClass !== 'agent-workflow') continue;
      expect(() => readFileSync(join(evidenceRoot, record.transcriptPath), 'utf8')).not.toThrow();
    }
  });

  test('scenario outcomes are exactly what the recorded rubrics support — no promotion', () => {
    const outcomes = retained.map((record) => scenarioOutcome(record));
    expect(outcomes.every((outcome) => outcome === 'PASS' || outcome === 'FAIL' || outcome === 'BLOCKED')).toBe(true);
    for (const record of retained) {
      if (scenarioOutcome(record) !== 'PASS') expect(unprovenCriteria(record)).not.toEqual([]);
    }
  });
});

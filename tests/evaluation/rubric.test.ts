import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  runNegativeControl,
  type ControlScenario,
  type ControlTranscript,
} from '../../scripts/evaluation/score.ts';

const fixtureRoot = join(import.meta.dir, '..', 'fixtures', 'context-evaluation');

function loadScenario(name: string): ControlScenario {
  return JSON.parse(readFileSync(join(fixtureRoot, 'tuning', `${name}-scenario.json`), 'utf8')) as ControlScenario;
}

function loadTranscript(name: string): ControlTranscript {
  return JSON.parse(readFileSync(join(fixtureRoot, 'tuning', `${name}-transcript.json`), 'utf8')) as ControlTranscript;
}

describe('negative controls', () => {
  test('resume control detects an omitted mandatory law', () => {
    const result = runNegativeControl(loadScenario('resume'), loadTranscript('resume-broken'));
    expect(result.detected).toBe(true);
    expect(result.omittedLaws).toEqual(['finish-active-before-new-build', 'verify-closes-the-loop']);
  });

  test('stale-checkpoint control detects false completion with omitted facts', () => {
    const result = runNegativeControl(loadScenario('stale-checkpoint'), loadTranscript('stale-checkpoint-broken'));
    expect(result.detected).toBe(true);
    expect(result.falseCompletion).toBe(true);
    expect(result.omittedFacts).toEqual(['stale-entry-flagged', 'current-spec-reread']);
  });

  test('refusal control detects a false source-read claim', () => {
    const result = runNegativeControl(loadScenario('refusal'), loadTranscript('refusal-broken'));
    expect(result.detected).toBe(true);
    expect(result.falseSourceReadClaims).toEqual(['src/core/board/lanes.ts:moveLane']);
  });

  test('review control does not flag a compliant transcript', () => {
    const result = runNegativeControl(loadScenario('review'), loadTranscript('review-clean'));
    expect(result.detected).toBe(false);
    expect(result.falseCompletion).toBe(false);
    expect(result.falseSourceReadClaims).toEqual([]);
  });

  test('a forbidden action alone is reported', () => {
    const scenario = loadScenario('review');
    const transcript: ControlTranscript = {
      scenarioId: scenario.id,
      events: [
        { kind: 'law-ack', law: 'review-blocks-archive' },
        { kind: 'fact-stated', fact: 'diff-attacked-against-spec' },
        { kind: 'action', name: 'archive-without-review' },
      ],
    };
    const result = runNegativeControl(scenario, transcript);
    expect(result.detected).toBe(true);
    expect(result.forbiddenActionPerformed).toEqual(['archive-without-review']);
  });

  test('rescoring a stored transcript is labeled replay, not new host execution', () => {
    const result = runNegativeControl(loadScenario('resume'), loadTranscript('resume-broken'), 'replay');
    expect(result.runKind).toBe('replay');
    expect(result.detected).toBe(true);
  });

  test('held-out labels stay separate from tuning fixtures', () => {
    const heldout = JSON.parse(readFileSync(join(fixtureRoot, 'heldout', 'scenarios.json'), 'utf8')) as ControlScenario[];
    const tuningIds = new Set(['tuning-resume', 'tuning-stale-checkpoint', 'tuning-refusal', 'tuning-review']);
    expect(heldout.length).toBeGreaterThanOrEqual(2);
    expect(heldout.every((scenario) => !tuningIds.has(scenario.id))).toBe(true);
  });
});

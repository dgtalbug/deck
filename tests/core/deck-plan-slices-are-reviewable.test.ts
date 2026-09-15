// deck-plan slice contract: multi-story intake must direct the agent to
// produce small reviewable slices — outcome, scope/non-goals, acceptance
// criteria, validation, an explicit dependency decision (edge or none),
// independent-shipping rationale (or the recorded reason a slice cannot
// ship alone), and criteria traceability — while small fixes stay
// lightweight with an explicit dependency none. Checked against the
// tracked authored source; the embedded-asset parity test elsewhere
// guards the generated copy.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const body = readFileSync(join(import.meta.dir, '..', '..', 'src', 'skills', 'deck-plan', 'SKILL.md'), 'utf8');

// Every entry names one required planning behavior; an empty result means
// the runbook carries the full slice contract.
function planningContractViolations(text: string): string[] {
  const violations: string[] = [];
  const output = text.slice(text.indexOf('## Output'));
  if (!/\boutcome\b/.test(text)) violations.push('slice outcome field');
  if (!/non-goals/.test(text)) violations.push('slice non-goals field');
  if (!/acceptance criteri/i.test(text)) violations.push('slice acceptance criteria field');
  if (!/\bvalidation\b/.test(text)) violations.push('slice validation field');
  if (!/deck deps /.test(text)) violations.push('dependency command (deck deps)');
  if (!/no dependency edge required/.test(text)) violations.push('explicit dependency none');
  if (!/deck epic-plan <epicId> link/.test(text)) violations.push('criterion link command');
  if (!/deck epic-plan <epicId> defer/.test(text)) violations.push('criterion defer command');
  if (!/uncovered/i.test(output)) violations.push('uncovered criteria named in output');
  if (!/ships independently/.test(text)) violations.push('independent-shipping statement');
  if (!/must land first/.test(text)) violations.push('non-independent slice ordering');
  if (!/≤3 tasks/.test(text) || !/deck-capture/.test(text)) violations.push('lightweight handoff to capture');
  if (!/dependencies: none/.test(text)) violations.push('lightweight explicit none');
  if (!/never db writes/.test(text)) violations.push('engine-doors-only law');
  return violations;
}

describe('deck-plan slice contract (tracked source)', () => {
  test('multi-story guidance carries every required slice field', () => {
    expect(planningContractViolations(body)).toEqual([]);
  });

  test('the Output template states the full slice contract per story', () => {
    const output = body.slice(body.indexOf('## Output'));
    for (const field of ['outcome', 'non-goals', 'acceptance criteria', 'validation', 'dependency decision', 'ships independently', 'build order']) {
      expect(output, `Output template must state: ${field}`).toContain(field);
    }
  });

  test('dependencies are recorded through the real command or stated as none', () => {
    expect(body).toMatch(/deck deps <story> add <prereq-story>/);
    expect(body).toMatch(/cycle-checked/);
    expect(body).toContain('no dependency edge required');
  });

  test('criteria traceability uses link/defer and names uncovered criteria', () => {
    expect(body).toMatch(/deck epic-plan <epicId> link <criterion-id> <storyId>/);
    expect(body).toMatch(/deck epic-plan <epicId> defer <criterion-id> --reason/);
    expect(body).toMatch(/without claiming the epic complete/);
  });

  test('negative control: pre-change guidance (list + build order only) fails the contract', () => {
    // The planning summary the runbook prescribed before the slice contract:
    // epic + story list + advisory build order — exactly the omissions the
    // workflow audit documented (no dependency decision, no criteria
    // mapping, no per-slice validation or non-goals).
    const seeded = [
      '# deck-plan — one idea in, a shaped plan out',
      '## 0. Select',
      'If it is single-concern and small (≤3 tasks), do NOT plan: hand to deck-capture.',
      '## 2. Act — the architect pass',
      'deck epic "<the idea, one line>"',
      'deck story <epicId> "<story 1 title>"',
      '## Output',
      'The plan: epic id, story list (id · type · tasks · purpose), build order recommendation.',
    ].join('\n');
    const violations = planningContractViolations(seeded);
    expect(violations).toContain('slice non-goals field');
    expect(violations).toContain('slice acceptance criteria field');
    expect(violations).toContain('slice validation field');
    expect(violations).toContain('dependency command (deck deps)');
    expect(violations).toContain('explicit dependency none');
    expect(violations).toContain('criterion link command');
    expect(violations).toContain('independent-shipping statement');
    expect(violations.length).toBeGreaterThan(7);
  });
});

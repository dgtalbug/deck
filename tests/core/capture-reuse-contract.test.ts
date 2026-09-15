// capture-reuse contract: the deck-capture runbook must make candidate
// lookup a mandatory step and record exactly one decision (reuse, update,
// distinct, clarify) before any card is created or groomed — a retried
// request reuses the open card instead of duplicating it, materially
// different work is captured separately with recorded reasoning, an
// ambiguous match asks before creating anything, and an interrupted
// continuation rechecks the board and keeps the existing card identity.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpProject } from '../helpers.ts';
import { openStore } from '../../src/core/board/store.ts';
import { boardView, todoView } from '../../src/core/board/views.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import type { GroomProposal } from '../../src/core/board/types.ts';

const captureBody = readFileSync(
  join(import.meta.dir, '..', '..', 'src', 'skills', 'deck-capture', 'SKILL.md'),
  'utf8',
);

// The four capture situations the reuse decision must distinguish. Each
// prompt plays against the same open card; only the decision changes.
export const captureScenarios = [
  {
    id: 'capture-retry-reuse',
    prompt: 'Retry: add the dark-mode toggle to the board toolbar.',
    openCard: 'add dark-mode toggle to the board toolbar',
    expectedDecision: 'reuse',
    rationale: 'the open card already covers the request',
  },
  {
    id: 'capture-distinct-work',
    prompt: 'Add a light-mode toggle to the board toolbar.',
    openCard: 'add dark-mode toggle to the board toolbar',
    expectedDecision: 'distinct',
    rationale: 'similar area, materially different outcome',
  },
  {
    id: 'capture-ambiguous-match',
    prompt: 'Make the toolbar theme configurable.',
    openCard: 'add dark-mode toggle to the board toolbar',
    expectedDecision: 'clarify',
    rationale: 'may be the same work; the distinction is unclear',
  },
  {
    id: 'capture-interrupted-continuation',
    prompt: 'Continue the capture you started for the toolbar dark-mode toggle.',
    openCard: 'add dark-mode toggle to the board toolbar',
    expectedDecision: 'update',
    rationale: 'same request resumed keeps the existing card identity',
  },
] as const;

// Every rule the capture runbook must carry, with failures naming the
// missing rule so a seeded regression is as specific as real drift.
function assertCaptureReuseContract(skill: string): void {
  const missing: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) missing.push(what);
  };
  need(/Candidate scan/.test(skill) && /mandatory before any `deck note`/.test(skill),
    'a candidate scan marked mandatory before `deck note`');
  need(/`deck board`/.test(skill), 'board listing as the candidate source');
  need(/`deck epics`/.test(skill), 'epic listing as the capability-level candidate source');
  need(/`deck recall "/.test(skill), 'memory recall as the past-work candidate source');
  need(/curl localhost:3325\/<project>\/board/.test(skill), 'board document read for candidate detail');
  need(/Record exactly ONE decision/.test(skill), 'the exactly-one-decision record rule');
  need(/\*\*reuse\*\*[^\n]*create nothing/.test(skill), 'reuse decision creating nothing');
  need(/\*\*update\*\*[^\n]*re-groom THAT card id/.test(skill), 'update decision re-grooming the matched card');
  need(/\*\*distinct\*\*[^\n]*why reuse would be wrong/.test(skill), 'distinct decision recording why reuse is wrong');
  need(/\*\*clarify\*\*[^\n]*ask ONE open question/.test(skill), 'clarify decision asking before capture');
  need(/create nothing until answered/.test(skill), 'clarify holding creation until answered');
  need(/repeated or retried request defaults to reuse\/update/.test(skill) && /never re-capture/.test(skill),
    'retry requests reusing instead of re-capturing');
  need(/interrupted and resumed/.test(skill) && /keep the existing card identity/.test(skill),
    'interrupted continuation rechecking state and preserving identity');
  need(/only when the scan decision is `distinct`/.test(skill), 'note creation gated on the distinct decision');
  need(/`update` decision grooms the EXISTING card id/.test(skill) && /`PATCH`/.test(skill),
    'update path grooming the existing card id (PATCH door)');
  need(/candidate decision first/.test(skill), 'output template leading with the decision record');
  expect(missing, `deck-capture is missing reuse-contract rules: ${missing.join('; ')}`).toEqual([]);
}

describe('capture reuse contract (authored runbook)', () => {
  test('the candidate scan, decision tree, retry rule, and resume rule are all present', () => {
    assertCaptureReuseContract(captureBody);
  });

  test('every scenario decision the contract requires is prescribed by the runbook', () => {
    const decisions = new Set(captureScenarios.map((scenario) => scenario.expectedDecision));
    expect(decisions).toEqual(new Set(['reuse', 'update', 'distinct', 'clarify']));
    for (const decision of decisions) {
      expect(captureBody).toMatch(new RegExp(`\\*\\*${decision}\\*\\*`));
    }
  });

  test('negative control: stripping the candidate scan fails the contract by name', () => {
    const start = captureBody.indexOf('### Candidate scan');
    const end = captureBody.indexOf('### Size the ask first');
    const seeded = captureBody.slice(0, start) + captureBody.slice(end);
    expect(() => assertCaptureReuseContract(seeded)).toThrow(/candidate scan/);
  });

  test('negative control: dropping the retry rule fails the contract by name', () => {
    const seeded = captureBody.replace(
      /^A repeated or retried request defaults to reuse\/update[^\n]*\n/m,
      '',
    );
    expect(() => assertCaptureReuseContract(seeded)).toThrow(/retry/);
  });
});

describe('capture reuse recipe is executable against a real board', () => {
  test('the prescribed listings surface the open card for every scenario, across interruption', async () => {
    const project = tmpProject('capture-reuse-');
    try {
      const store = await openStore(project.path);
      const candidate = store.addNote(captureScenarios[0]!.openCard);

      // the `deck board --view todo` recipe names the candidate before any
      // new note exists — the retry scenario can therefore reuse it
      const todo = todoView(store);
      expect(todo.cards.map((card) => card['id'])).toContain(candidate.id);

      // the full-board document read carries the candidate's detail fields
      const board = boardView(store);
      expect(board.lanes['todo']!.map((card) => card['id'])).toContain(candidate.id);

      // grooming moves the candidate to groomed; it stays a visible capture
      // candidate, so a later retry still matches the same card
      const item = convertToVerbItem(store, proposal(candidate.id, captureScenarios[0]!.openCard));
      expect(todoView(store).cards.map((card) => card['id'])).toContain(item.id);

      // interrupted continuation: the store is reopened (fresh process
      // view); the scan recipe recovers the same card identity
      const reopened = await openStore(project.path);
      expect(todoView(reopened).cards.map((card) => card['id'])).toContain(item.id);
      expect(boardView(reopened).lanes['groomed']!.map((card) => card['id'])).toContain(item.id);
    } finally {
      project.cleanup();
    }
  });
});

function proposal(noteId: string, title: string): GroomProposal {
  return {
    noteId,
    proposedVerb: 'chore',
    refinedTitle: title,
    research: { codebaseFindings: [], sections: { reproduce: 'r', rca: 'c' } },
    specDeltas: [],
    tasks: ['one task'],
    openQuestions: [],
  };
}

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { enrollPolicy, getPolicy, PolicyValidationError } from '../../src/core/board/rules.ts';

// Task 1.4 — delivery/evidence policy contracts: team default / explicit solo,
// named checks must exist, manual designation limited to classified criteria,
// and every accepted change bumps the policy version.
let dir: string;
let store: DocumentStore;

function seedVerbCard(title: string): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: [],
    openQuestions: [],
  });
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-evidence-policy-'));
  writeFileSync(
    join(dir, 'deck.rules.yaml'),
    ['version: 1', 'principles:', '  - id: unit-tests', '    rule: tests pass', '    check: exit 0'].join('\n'),
  );
  store = await openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('delivery/evidence policy', () => {
  test('absence of enrollment is not solo — new scope has no implicit policy', () => {
    const id = seedVerbCard('unenrolled card');
    expect(getPolicy(store, id)).toBeUndefined();
  });

  test('team enrollment is the explicit default shape; solo is a persisted choice', () => {
    const id = seedVerbCard('mode card');
    const team = enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    expect(team.mode).toBe('team');
    expect(team.version).toBe(1);
    expect(team.requiredChecks).toEqual(['unit-tests']);
    const solo = enrollPolicy(store, id, { mode: 'solo' });
    expect(solo.mode).toBe('solo');
    expect(solo.version).toBe(2);
    expect(solo.enrolledAt).toBe(team.enrolledAt); // enrollment date preserved
  });

  test('required check must be a machine-checked principle in deck.rules.yaml', () => {
    const id = seedVerbCard('bad check card');
    expect(() => enrollPolicy(store, id, { mode: 'team', requiredChecks: ['no-such-check'] })).toThrow(
      PolicyValidationError,
    );
  });

  test('manual designation requires an active classified criterion', () => {
    const id = seedVerbCard('manual assignment card');
    // Scope carries no classified criterion identity yet — unclassified legacy
    // criteria cannot take a manual designation.
    expect(() => enrollPolicy(store, id, { mode: 'team', manualCriteria: ['c-unknown'] })).toThrow(
      PolicyValidationError,
    );
  });

  test('invalid inputs refuse: negative approvals', () => {
    const id = seedVerbCard('invalid policy card');
    expect(() =>
      enrollPolicy(store, id, {
        mode: 'team',
        requiredApprovals: -1,
      } as Parameters<typeof enrollPolicy>[2]),
    ).toThrow();
  });

  test('policy version bumps on every accepted change so old evidence stops counting', () => {
    const id = seedVerbCard('version card');
    const v1 = enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    const v2 = enrollPolicy(store, id, { mode: 'team', requiredChecks: ['unit-tests'] });
    expect(v2.version).toBe(v1.version + 1);
  });
});

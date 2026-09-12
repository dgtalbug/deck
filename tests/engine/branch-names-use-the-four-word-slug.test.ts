import { describe, expect, test } from 'bun:test';
import { branchFor } from '../../src/core/engine/verbs.ts';

// Requirement: branch names use the four word title slug — verb/slug, the
// conventional-commit shape; the title appears exactly once (the card id no
// longer duplicates it); first four words, ≤32 chars, deterministic.
describe('branchFor four-word law', () => {
  test('verb + four-word title slug, no card id', () => {
    expect(branchFor({ id: 'epic-planning-epic-1l6j', title: 'Epic planning: epic containers' }, 'feat')).toBe(
      'feat/epic-planning-epic-containers',
    );
    expect(branchFor({ id: 'git-page-tabs-fjfw', title: 'Git page tabs + top project bar' }, 'feat')).toBe(
      'feat/git-page-tabs-top',
    );
  });

  test('longer titles truncate to the first four words within 32 chars', () => {
    const name = branchFor({ id: 'x1', title: 'Stabilization audit closes sync sse tweak float archive verify gaps' }, 'fix');
    expect(name).toBe('fix/stabilization-audit-closes-sync');
    expect(name.length).toBeLessThanOrEqual(4 + 1 + 32);
  });

  test('empty-title cards fall back to the id for uniqueness', () => {
    expect(branchFor({ id: 'note-abcd', title: '---' }, 'chore')).toBe('chore/note-abcd');
  });

  test('the same card re-derives the same name (deterministic)', () => {
    const card = { id: 'stable-id-9z', title: 'Deterministic names for builds' };
    expect(branchFor(card, 'feat')).toBe(branchFor({ ...card }, 'feat'));
  });
});

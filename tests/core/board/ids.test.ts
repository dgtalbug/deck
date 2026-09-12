import { describe, expect, test } from 'bun:test';
import { newCardId, newTaskId } from '../../../src/core/board/ids.ts';

describe('newCardId', () => {
  test('is the bare title slug — no random suffix', () => {
    expect(newCardId('Fix Login Flicker!')).toBe('fix-login-flicker');
  });

  test('caps the slug at three words', () => {
    expect(newCardId('one two three four five six')).toBe('one-two-three');
  });

  test('falls back to `card` for slug-less titles', () => {
    expect(newCardId('???')).toBe('card');
  });

  test('collision numbering: bare slug first, then -2, -3 (Jira-style)', () => {
    const taken = new Set(['same-title', 'same-title-2']);
    expect(newCardId('same title', (id) => taken.has(id))).toBe('same-title-3');
    expect(newCardId('same title', (id) => taken.has(id))).toBe('same-title-3');
  });

  test('no collisions in a taken-free world means bare slugs everywhere', () => {
    expect(newCardId('fresh idea', () => false)).toBe('fresh-idea');
  });
});

describe('newTaskId', () => {
  test('is short and prefixed', () => {
    expect(newTaskId()).toMatch(/^t-[a-z0-9]{1,6}$/);
  });
});

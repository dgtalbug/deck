import { describe, expect, test } from 'bun:test';
import { newCardId, newTaskId } from '../../../src/core/board/ids.ts';

describe('newCardId', () => {
  test('slugifies the title with a random suffix', () => {
    const id = newCardId('Fix Login Flicker!');
    expect(id).toMatch(/^fix-login-flicker-[a-z0-9]{4}$/);
  });

  test('caps the slug at three words', () => {
    const id = newCardId('one two three four five six');
    expect(id).toMatch(/^one-two-three-[a-z0-9]{4}$/);
  });

  test('falls back to a random id for slug-less titles', () => {
    const id = newCardId('???');
    expect(id).toMatch(/^card-[a-z0-9]{4}$/);
  });

  test('two ids for the same title differ', () => {
    expect(newCardId('same title')).not.toBe(newCardId('same title'));
  });
});

describe('newTaskId', () => {
  test('is short and prefixed', () => {
    expect(newTaskId()).toMatch(/^t-[a-z0-9]{1,6}$/);
  });
});

import { describe, expect, test } from 'bun:test';
import { LaneViolation, NotFoundError, WipLimitError } from '../../../src/core/board/errors.ts';

describe('typed errors', () => {
  test('LaneViolation message names card, lanes, and source', () => {
    const error = new LaneViolation('fix-login-k3qz', 'groomed', 'active', 'human');
    expect(error.message).toContain('fix-login-k3qz');
    expect(error.message).toContain('groomed');
    expect(error.message).toContain('active');
    expect(error.message).toContain('human');
    expect(error.details).toEqual({
      cardId: 'fix-login-k3qz',
      from: 'groomed',
      to: 'active',
      source: 'human',
    });
  });

  test('WipLimitError message names counts and the card to finish', () => {
    const error = new WipLimitError(3, 3, 'feat-engine-x1');
    expect(error.message).toContain('3/3');
    expect(error.message).toContain('feat-engine-x1');
  });

  test('NotFoundError names entity and id', () => {
    const error = new NotFoundError('card', 'nope-1234');
    expect(error.message).toContain('card');
    expect(error.message).toContain('nope-1234');
  });
});

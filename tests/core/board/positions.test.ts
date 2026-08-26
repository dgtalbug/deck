import { describe, expect, test } from 'bun:test';
import {
  endPosition,
  gapTooSmall,
  midpoint,
  renumberPositions,
} from '../../../src/core/board/positions.ts';

describe('positions', () => {
  test('endPosition is step past the max, or the step for an empty lane', () => {
    expect(endPosition([])).toBe(1024);
    expect(endPosition([1024, 3072])).toBe(3072 + 1024);
  });

  test('midpoint lands strictly between neighbors', () => {
    const mid = midpoint(1024, 2048);
    expect(mid).toBeGreaterThan(1024);
    expect(mid).toBeLessThan(2048);
  });

  test('gapTooSmall triggers below 1e-6', () => {
    expect(gapTooSmall(1, 1 + 5e-7)).toBe(true);
    expect(gapTooSmall(1, 2)).toBe(false);
  });

  test('renumberPositions spaces the lane at step intervals', () => {
    expect(renumberPositions(3)).toEqual([1024, 2048, 3072]);
  });
});

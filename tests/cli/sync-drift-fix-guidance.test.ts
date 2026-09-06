import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// verify-fix — the paired file for the "Sync drift fix guidance"
// requirement: the flush-failure drift hint prescribes deck-owned fixes
// only (never 'publish manually').
const publish = readFileSync(join(import.meta.dir, '../../src/core/board/publish.ts'), 'utf8');

describe('sync drift fix guidance', () => {
  test('the flush-failure drift hint prescribes re-running deck sync', () => {
    expect(publish).toMatch(/fix: 're-run deck sync once gh can reach GitHub/);
  });

  test('the zero-manual-gh law holds in every drift hint', () => {
    expect(publish).not.toContain('publish manually');
  });
});

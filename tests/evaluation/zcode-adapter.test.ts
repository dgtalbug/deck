import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseModelIoFile } from '../../scripts/evaluation/zcode-adapter.ts';

// Contract check against the verified zcode 0.16.5 receipt shape: per-turn
// usage, durationMs and named tool calls, with malformed lines tolerated.
describe('zcode receipt contract', () => {
  test('sums tokens, wall time and tool calls across turns', () => {
    const parsed = parseModelIoFile(join(import.meta.dir, '..', 'fixtures', 'context-evaluation', 'receipts', 'model-io-fixture.jsonl'));
    expect(parsed.model).toBe('GLM-5.3');
    expect(parsed.accounting).toEqual({ inputTokens: 300, outputTokens: 30, totalTokens: 330, wallTimeMs: 2000, toolCalls: 3, spend: 0 });
    expect(parsed.toolNames).toEqual(['Read', 'Edit', 'Bash']);
  });
});

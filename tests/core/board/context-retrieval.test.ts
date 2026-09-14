import { describe, expect, test } from 'bun:test';
import { extractSymbols, retrieveReferences } from '../../../src/core/board/context-retrieval.ts';

const corpus = [
  { path: 'src/board/next.ts', bytes: 'export function assemble() {}\nexport function envelope() {}\n' },
  { path: 'src/board/scope.ts', bytes: 'export const scopeRevision = 1;\nexport function assemble() {}\n' },
  { path: 'src/other.ts', bytes: 'export function unrelated() {}\n' },
];

describe('deterministic path/keyword retrieval', () => {
  test('extracts top-level symbols deterministically', () => {
    expect(extractSymbols(corpus[0]!.bytes!)).toEqual(['assemble', 'envelope']);
  });

  test('ranks symbol matches above plain content matches', () => {
    const ranked = retrieveReferences('assemble', corpus, 10).map((r) => r.reference);
    expect(ranked).toContain('src/board/next.ts:assemble');
    expect(ranked).toContain('src/board/scope.ts:assemble');
    expect(ranked).not.toContain('src/other.ts:unrelated');
  });

  test('equal scores break by reference code-point order, stably', () => {
    const first = retrieveReferences('assemble', corpus, 10).map((r) => r.reference);
    const second = retrieveReferences('assemble', [...corpus].reverse(), 10).map((r) => r.reference);
    expect(first).toEqual(second);
  });

  test('respects the K=10 limit', () => {
    const wide = Array.from({ length: 30 }, (_, i) => ({
      path: `src/m${i}.ts`,
      bytes: 'export function assemble() {}\n',
    }));
    expect(retrieveReferences('assemble', wide, 10)).toHaveLength(10);
  });

  test('files with no bytes are skipped', () => {
    const ranked = retrieveReferences('assemble', [{ path: 'src/gone.ts', bytes: null }], 10);
    expect(ranked).toEqual([]);
  });
});

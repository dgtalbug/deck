import { describe, expect, test } from 'bun:test';
import { displayWidth, pad, padLeft, truncateTitle } from '../../src/cli/format.ts';

describe('displayWidth (wcwidth semantics)', () => {
  test('ascii counts 1 per glyph', () => {
    expect(displayWidth('fix login loop')).toBe(14);
  });

  test('CJK counts 2, combining counts 0', () => {
    expect(displayWidth('ストリーミング')).toBe(14); // 7 glyphs × 2
    expect(displayWidth('e\u0301')).toBe(1);
  });

  test('ambiguous counts 1', () => {
    expect(displayWidth('·…⚠')).toBe(3);
  });
});

describe('truncateTitle', () => {
  test('short title pads to 44', () => {
    const out = truncateTitle('add CSV export');
    expect(out.length).toBe(44);
    expect(out.startsWith('add CSV export')).toBe(true);
  });

  test('long ascii title gets ellipsis at col 44', () => {
    const out = truncateTitle('x'.repeat(60));
    expect(out.length).toBe(44);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, 43)).toBe('x'.repeat(43));
  });

  test('dumb terminal uses ASCII tilde', () => {
    expect(truncateTitle('x'.repeat(60), 44, true).endsWith('~')).toBe(true);
  });

  test('CJK cut backs off rather than splitting a width-2 glyph', () => {
    const out = truncateTitle('ストリーミング grooming 出力をカードに表示する');
    expect(out.endsWith('…')).toBe(true);
    const used = displayWidth(out.slice(0, -1));
    expect(used).toBeLessThanOrEqual(43);
    expect(used % 2 === 0 || used === 43).toBe(true);
  });
});

describe('grid helpers', () => {
  test('pad and padLeft', () => {
    expect(pad('ab', 5)).toBe('ab   ');
    expect(padLeft('7', 4)).toBe('   7');
    expect(pad('abcdef', 3)).toBe('abcdef'); // never truncates ids
  });
});

import { describe, expect, test } from 'bun:test';
import { detectLevel, palette, stripSgr } from '../../src/cli/color.ts';

describe('color level detection (locked order)', () => {
  test('NO_COLOR wins over everything', () => {
    expect(detectLevel({ NO_COLOR: '1', COLORTERM: 'truecolor', TERM: 'xterm-256color' }, true)).toBe('off');
  });

  test('non-TTY is off', () => {
    expect(detectLevel({ TERM: 'xterm-256color' }, false)).toBe('off');
  });

  test('FORCE_COLOR=1 overrides isatty only', () => {
    expect(detectLevel({ FORCE_COLOR: '1', TERM: 'xterm-256color' }, false)).toBe('256');
    expect(detectLevel({ FORCE_COLOR: '1', NO_COLOR: '1', TERM: 'xterm' }, true)).toBe('off');
    expect(detectLevel({ FORCE_COLOR: '1', TERM: 'dumb' }, true)).toBe('off');
  });

  test('TERM=dumb is off', () => {
    expect(detectLevel({ TERM: 'dumb' }, true)).toBe('off');
  });

  test('COLORTERM truecolor beats 256color', () => {
    expect(detectLevel({ COLORTERM: 'truecolor', TERM: 'xterm-256color' }, true)).toBe('24bit');
  });

  test('256 then 16 fallback', () => {
    expect(detectLevel({ TERM: 'xterm-256color' }, true)).toBe('256');
    expect(detectLevel({ TERM: 'xterm' }, true)).toBe('16');
    expect(detectLevel({}, true)).toBe('16');
  });
});

describe('palette mapping', () => {
  test('lime at all three levels', () => {
    expect(palette('24bit').color('primary', 'x')).toBe('\x1b[38;2;159;225;24mx\x1b[0m');
    expect(palette('256').color('primary', 'x')).toBe('\x1b[38;5;154mx\x1b[0m');
    expect(palette('16').color('primary', 'x')).toBe('\x1b[92mx\x1b[0m');
  });

  test('16-color lime owns bright green, success plain green', () => {
    expect(palette('16').color('primary', 'x')).toBe('\x1b[92mx\x1b[0m');
    expect(palette('16').color('success', 'x')).toBe('\x1b[32mx\x1b[0m');
  });

  test('off emits zero SGR sequences', () => {
    const p = palette('off');
    const text = `${p.color('primary', 'a')}${p.dim('b')}${p.bold('c')}`;
    expect(text).toBe('abc');
    expect(stripSgr(text)).toBe(text);
  });

  test('muted scale rides SGR 2/1, never greys', () => {
    expect(palette('256').dim('x')).toBe('\x1b[2mx\x1b[0m');
    expect(palette('256').bold('x')).toBe('\x1b[1mx\x1b[0m');
  });
});

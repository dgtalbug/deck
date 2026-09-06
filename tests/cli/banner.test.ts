import { describe, expect, test } from 'bun:test';
import {
  bannerAscii,
  bannerBox,
  bannerCompact,
  defaultBannerFacts,
  pickBanner,
} from '../../src/cli/banner.ts';
import { palette, stripSgr } from '../../src/cli/color.ts';

describe('banner selection', () => {
  test('UTF-8 + color picks box-drawing', () => {
    expect(pickBanner({ locale: 'en_US.UTF-8', level: '256', cols: 80, rows: 24 })).toBe('box');
  });

  test('no color or non-UTF-8 picks strict ASCII', () => {
    expect(pickBanner({ locale: 'en_US.UTF-8', level: 'off', cols: 80, rows: 24 })).toBe('ascii');
    expect(pickBanner({ locale: 'C', level: '24bit', cols: 80, rows: 24 })).toBe('ascii');
  });

  test('size guard picks compact regardless of locale', () => {
    expect(pickBanner({ locale: 'en_US.UTF-8', level: '24bit', cols: 50, rows: 24 })).toBe('compact');
    expect(pickBanner({ locale: 'en_US.UTF-8', level: '24bit', cols: 80, rows: 10 })).toBe('compact');
  });
});

describe('banner rendering', () => {
  const p = palette('24bit');

  test('8 lines, version present, never lime borders', () => {
    for (const banner of [bannerAscii('0.3.0', p), bannerBox('0.3.0', p)]) {
      const lines = banner.split('\n');
      expect(lines.length).toBe(8);
      expect(banner).toContain('v0.3.0');
      // lime appears only around the pip (lines 3–6), never on border lines
      expect(stripSgr(lines[0]!)).not.toMatch(/\x1b/);
    }
  });

  test('off palette is plain text', () => {
    expect(stripSgr(bannerBox('0.3.0', palette('off')))).toBe(bannerBox('0.3.0', palette('off')));
  });

  test('compact is 3 lines with the pip only', () => {
    const lines = bannerCompact('0.3.0', p).split('\n');
    expect(lines.length).toBe(3);
    expect(stripSgr(bannerCompact('0.3.0', p))).toContain('♠ deck v0.3.0');
  });
});

describe('banner facts derive from the shared resolution', () => {
  const p = palette('off');

  test('default facts carry the real default port and database name', () => {
    expect(defaultBannerFacts()).toEqual({
      boardUrl: 'http://127.0.0.1:3325',
      dataPath: '.deck/board.sqlite',
    });
    expect(bannerCompact('0.3.0', p)).toContain('http://127.0.0.1:3325');
    expect(bannerCompact('0.3.0', p)).toContain('.deck/board.sqlite');
  });

  test('DECK_PORT flows through the default facts', () => {
    expect(defaultBannerFacts({ DECK_PORT: '4041' }).boardUrl).toBe('http://127.0.0.1:4041');
  });

  test('explicit facts win over defaults', () => {
    const out = bannerCompact('0.3.0', p, { boardUrl: 'http://127.0.0.1:9000', dataPath: 'x/y.sqlite' });
    expect(out).toContain('http://127.0.0.1:9000');
    expect(out).toContain('x/y.sqlite');
    expect(out).not.toContain('3325');
  });
});

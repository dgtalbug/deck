import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// release-0-6-0 — the paired file for the "Package publish surface"
// requirement: package.json and src/version.ts agree, every surface field
// present.
describe('package publish surface', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')) as Record<string, unknown>;

  test('version agrees with DECK_VERSION (one version, no drift)', () => {
    const version = readFileSync(join(import.meta.dir, '../../src/version.ts'), 'utf8');
    expect(version).toContain(`export const DECK_VERSION = '${pkg['version']}'`);
    expect(pkg['version']).toBe('0.6.0');
  });

  test('every publish field is present', () => {
    expect(pkg['name']).toBe('@dgtalbug/deck');
    expect(pkg['bin']).toEqual({ deck: './deck' });
    expect(typeof pkg['description']).toBe('string');
    expect(pkg['license']).toBe('MIT');
    expect(pkg['repository']).toMatchObject({ url: expect.stringContaining('dgtalbug/deck') });
    expect(pkg['engines']).toMatchObject({ bun: expect.any(String) });
    expect(Array.isArray(pkg['files'])).toBe(true);
    expect(pkg['files']).toEqual(expect.arrayContaining(['src/', 'deck', 'README.md']));
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// split-screen fix — the paired file for the "Sidebar shrinks below
// content" requirement: min-width 0 + wrap-anywhere path, shrinkable track.
const app = readFileSync(join(import.meta.dir, '../../src/ui/styles/app.css'), 'utf8');

describe('sidebar shrinks below content', () => {
  test('the sidebar accepts widths narrower than its content min-content', () => {
    expect(app).toMatch(/\.sidebar \{[^}]*min-width: 0/s);
  });

  test('the sidebar path wraps anywhere instead of stretching the sidebar', () => {
    expect(app).toMatch(/\.sidebar-path \{[^}]*overflow-wrap: anywhere/s);
  });

  test('the collapsed single-column track is shrinkable (minmax(0, 1fr))', () => {
    expect(app).toMatch(/@media \(max-width: 900px\) \{\s*\.board-shell \{\s*grid-template-columns: minmax\(0, 1fr\);/m);
  });
});

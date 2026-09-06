import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// responsive-ui — the paired file for the "Responsive shell breakpoints"
// requirement: the pinned viewport contract (1100 / 900 / 640) is written
// into the stylesheets, and the shell collapses at 900px.
const app = readFileSync(join(import.meta.dir, '../../src/ui/styles/app.css'), 'utf8');

describe('responsive shell breakpoints', () => {
  test('the viewport contract names all three pinned breakpoints', () => {
    expect(app).toContain('responsive-ui: the viewport contract');
    expect(app).toMatch(/1100px/);
    expect(app).toMatch(/900px/);
    expect(app).toMatch(/640px/);
  });

  test('the shell drops the sidebar rail to one column at 900px', () => {
    expect(app).toMatch(/@media \(max-width: 900px\) \{\s*\.board-shell \{\s*grid-template-columns: 1fr;\s*\}/m);
  });

  test('no breakpoint outside the pinned set is introduced', () => {
    const found = [...app.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => m[1]);
    const allowed = new Set(['640', '900', '1100']);
    for (const width of found) expect(allowed.has(width)).toBe(true);
  });
});

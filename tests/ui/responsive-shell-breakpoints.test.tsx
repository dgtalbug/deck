import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// responsive-ui — the paired file for the "Responsive shell breakpoints"
// requirement: the pinned viewport contract (1100 / 900 / 640) is written
// into the stylesheets. v0.7.0: the sidebar rail is gone — 900px no longer
// stacks a shell grid; the git tabs scroll within their row instead.
const app = readFileSync(join(import.meta.dir, '../../src/ui/styles/app.css'), 'utf8');

describe('responsive shell breakpoints', () => {
  test('the viewport contract names all three pinned breakpoints', () => {
    expect(app).toContain('responsive-ui: the viewport contract');
    expect(app).toMatch(/1100px/);
    expect(app).toMatch(/900px/);
    expect(app).toMatch(/640px/);
  });

  test('the sidebar shell grid is fully retired', () => {
    expect(app).not.toMatch(/\.board-shell/);
    expect(app).not.toMatch(/\.sidebar\s*\{/);
  });

  test('git tabs scroll within their row instead of growing the page', () => {
    expect(app).toMatch(/\.git-tabs \{[\s\S]*?overflow-x: auto;/);
  });

  test('no breakpoint outside the pinned set is introduced', () => {
    const found = [...app.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => m[1]);
    const allowed = new Set(['640', '900', '1100']);
    for (const width of found) expect(allowed.has(width)).toBe(true);
  });
});

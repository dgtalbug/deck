import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Visible keyboard focus for the board's pill controls. Several pill-style
// controls use `all: unset`, which erases the global :focus-visible ring
// (equal-or-lower specificity) — these controls must pin their own
// token-driven ring so keyboard focus is visible in light AND dark mode.
const app = readFileSync(join(import.meta.dir, '../../src/ui/styles/app.css'), 'utf8');
const spade = readFileSync(join(import.meta.dir, '../../src/ui/styles/spade.css'), 'utf8');

describe('visible focus on pill controls', () => {
  test('view-switch buttons restore a keyboard ring that all:unset erased', () => {
    expect(app).toMatch(/\.view-switch-btn:focus-visible \{[^}]*outline: 2px solid var\(--primary-vivid\)/s);
    // the segmented container clips overflow — the ring must stay inside
    expect(app).toMatch(/\.view-switch-btn:focus-visible \{[^}]*outline-offset: -2px/s);
    // the unset must still be there (otherwise the rule is protecting nothing)
    expect(app).toMatch(/\.view-switch-btn \{[^}]*all: unset/s);
  });

  test('detail/git tabs restore a keyboard ring that all:unset erased', () => {
    expect(spade).toMatch(/\.tabs \.tab:focus-visible \{[^}]*outline: 2px solid var\(--primary-vivid\)/s);
    expect(spade).toMatch(/\.tabs \.tab \{[^}]*all: unset/s);
  });

  test('cards, rows, and menu items keep their existing keyboard rings', () => {
    expect(app).toMatch(/\.kcard \.menu-btn:focus-visible/s);
    expect(app).toMatch(/\.kcard-open:focus-visible \{[^}]*outline: 2px solid var\(--primary-vivid\)/s);
    // menu-item styles live in app.css (page layer), not spade
    expect(app).toMatch(/\.menu-item:focus-visible/s);
    // the row open control is a real button with all:unset — it pins its own
    // ring, and the row highlights via :focus-within (container is inert)
    expect(spade).toMatch(/\.todo-row \.todo-open:focus-visible \{[^}]*outline: 2px solid var\(--primary-vivid\)/s);
    expect(spade).toMatch(/\.todo-row:focus-within \{[^}]*border-color: var\(--border-2\)/s);
    expect(spade).toMatch(/\.todo-row \.todo-open \{[^}]*all: unset/s);
    // global default for everything else
    expect(spade).toMatch(/:focus-visible \{[^}]*outline: 2px solid var\(--primary-vivid\)/s);
  });
});

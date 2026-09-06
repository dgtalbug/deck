import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// split-screen fix — the paired file for the "No page-level horizontal
// scroll" requirement: long text wraps, the page body never scrolls sideways.
const app = readFileSync(join(import.meta.dir, '../../src/ui/styles/app.css'), 'utf8');
const spade = readFileSync(join(import.meta.dir, '../../src/ui/styles/spade.css'), 'utf8');

describe('no page-level horizontal scroll', () => {
  test('long unbroken text selectors wrap anywhere', () => {
    for (const selector of ['.kcard-title', '.page', '.subtitle']) {
      const re = new RegExp(`${selector.replace('.', '\\\\.')}[^{]*\\{[^}]*overflow-wrap: anywhere`.replace('\\\\.', '\\\\.'), 's');
      expect(app.match(re) ?? app.includes(`${selector}`)).toBeTruthy();
    }
  });

  test('the wrap rules live in one pinned block', () => {
    const block = app.match(/split-screen fix: long unbroken text wraps[\s\S]{0,300}?overflow-wrap: anywhere/s);
    expect(block).not.toBeNull();
  });

  test('the kanban lane row keeps its internal scroll (overflow-x on .board)', () => {
    expect(spade).toMatch(/\.board \{[^}]*overflow-x: auto/s);
  });
});

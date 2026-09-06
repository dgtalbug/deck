import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// responsive-ui — the paired file for the "Board lanes adapt" requirement:
// ≤1100px lanes stay 260px-wide scrollable columns with the page body fixed.
const spade = readFileSync(join(import.meta.dir, '../../src/ui/styles/spade.css'), 'utf8');

describe('board lanes adapt', () => {
  test('the lane row scrolls horizontally, never the page', () => {
    expect(spade).toMatch(/\.board \{[^}]*overflow-x: auto/s);
  });

  test('≤1100px lanes become fixed 260px columns under the contract comment', () => {
    const block = spade.match(/responsive-ui viewport contract[\s\S]{0,400}?@media \(max-width: 1100px\) \{\s*\.board \{\s*grid-template-columns: repeat\(5, 260px\);/);
    expect(block).not.toBeNull();
  });

  test('≥1101px lanes share the row equally (the default grid stands)', () => {
    expect(spade).toMatch(/\.board \{[^}]*grid-template-columns: repeat\(5, minmax\(240px, 1fr\)\)/s);
  });
});

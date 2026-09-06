import { afterAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { Dialog } from '../../src/ui/components/Dialog.tsx';
import { installDom, type TestWindow } from './dom.ts';
import type { HTMLDivElement as HdomDiv } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// responsive-ui — the paired file for the "Dialogs fit small screens"
// requirement: ≤640px dialogs cap to viewport minus the 24px gutter,
// scroll vertically, and inputs fill the width.
const app = readFileSync(join(import.meta.dir, '../../src/ui/styles/app.css'), 'utf8');
const mountedContainers: HdomDiv[] = [];

afterAll(() => {
  for (const container of mountedContainers) render(null, container);
});

describe('dialogs fit small screens', () => {
  test('the 640px tier caps width to viewport minus the 24px gutter', () => {
    const tier = app.match(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/);
    expect(tier).not.toBeNull();
    expect(tier![0]).toContain('width: calc(100vw - 24px)');
    expect(tier![0]).toMatch(/max-height: 82vh/);
  });

  test('inputs fill the available width in the tier', () => {
    const tier = app.match(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/);
    expect(tier![0]).toMatch(/input\[type='text'\][\s\S]*?width: 100%/);
  });

  test('the dialog mounts with the chrome the tier targets (scrim + card dialog)', async () => {
    const win: TestWindow = installDom();
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    mountedContainers.push(container);
    render(
      <Dialog open label="probe" onClose={() => undefined}>
        <p>body</p>
      </Dialog>,
      container,
    );
    expect(win.document.querySelector('.scrim.open .card.dialog')).not.toBeNull();
  });
});

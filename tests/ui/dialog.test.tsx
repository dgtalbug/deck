import { describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { Dialog } from '../../src/ui/components/Dialog.tsx';
import type { HTMLElement as Hdom } from 'happy-dom';
import { installDom, press } from './dom.ts';

function Harness(): VNode {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button id="opener" onClick={() => setOpen(true)}>open</button>
      <Dialog open={open} label="test dialog" onClose={() => setOpen(false)}>
        <button id="first">first</button>
        <button id="last">last</button>
      </Dialog>
    </div>
  );
}

describe('Dialog keyboard walkthrough', () => {
  test('Esc closes; Tab is trapped; focus is restored', async () => {
    const win = installDom();
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    render(<Harness />, container);

    const opener = win.document.querySelector('#opener') as unknown as Hdom;
    opener.focus();
    opener.click();
    await new Promise((resolve) => setTimeout(resolve, 50)); // preact re-render flushes on rAF

    const scrim = win.document.querySelector('.scrim');
    expect(scrim).not.toBeNull();
    expect(scrim!.getAttribute('role')).toBe('dialog');
    expect(scrim!.getAttribute('aria-modal')).toBe('true');

    const dialog = win.document.querySelector('.card.dialog') as unknown as Hdom;
    const first = win.document.querySelector('#first') as unknown as Hdom;
    const last = win.document.querySelector('#last') as unknown as Hdom;

    // focus starts inside the dialog
    expect(win.document.activeElement === dialog || win.document.activeElement === first).toBe(true);

    // Tab cycles within the dialog (trap)
    press(win, dialog, 'Tab');
    expect(win.document.activeElement).toBe(first);
    press(win, first, 'Tab');
    expect(win.document.activeElement).toBe(last);
    press(win, last, 'Tab');
    expect(win.document.activeElement).toBe(first); // wrapped
    press(win, first, 'Tab', true);
    expect(win.document.activeElement).toBe(last); // shift-wrap

    // Esc closes (re-render flushes on the next frame)
    press(win, win.document.activeElement!, 'Escape');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(win.document.querySelector('.scrim')).toBeNull();
    // focus returned to the invoking element (restored at unmount)
    expect(win.document.activeElement).toBe(opener);
  });
});

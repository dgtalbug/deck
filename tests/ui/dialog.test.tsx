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

describe('Dialog focus stability across re-renders', () => {
  test('a keystroke re-render never steals focus from the field', async () => {
    const win = installDom();
    function TypedHarness(): VNode {
      const [open, setOpen] = useState(false);
      const [text, setText] = useState('');
      return (
        <div>
          <button id="opener" onClick={() => setOpen(true)}>open</button>
          <Dialog open={open} label="typing dialog" onClose={() => setOpen(false)}>
            <input id="typed" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
          </Dialog>
        </div>
      );
    }
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);
    render(<TypedHarness />, container);
    const opener = win.document.querySelector('#opener') as unknown as Hdom;
    opener.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const typed = win.document.querySelector('#typed') as unknown as HTMLInputElement;
    typed.focus();
    const setter = Object.getOwnPropertyDescriptor(
      (typed.constructor as typeof HTMLInputElement).prototype,
      'value',
    )!.set!;
    for (const ch of ['a', 'b', 'c']) {
      setter.call(typed, typed.value + ch);
      typed.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
      await new Promise((resolve) => setTimeout(resolve, 30)); // re-render + microtasks flush
      expect(win.document.activeElement).toBe(typed); // focus must stay in the field
    }
    expect(typed.value).toBe('abc');
  });
});

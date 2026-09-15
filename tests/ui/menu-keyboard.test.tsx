import { describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { Menu } from '../../src/ui/components/Menu.tsx';
import type { HTMLElement as Hdom } from 'happy-dom';
import { installDom, press } from './dom.ts';

// Menu keyboard contract: Enter/Space open from the trigger, Arrow keys move
// through items, Escape closes and restores trigger focus, and selection
// closes the menu before invoking the action. Component-level — the board
// wiring (card/todo-row menus) is covered in dnd.test.tsx.

let win: ReturnType<typeof installDom>;

function menuItems(labels: string[], log: string[]) {
  return labels.map((label) => ({
    label,
    onSelect: () => {
      log.push(`select:${label}`);
      log.push(`menu-open-at-select:${win.document.querySelector('.menu-pop:not([hidden])') !== null}`);
    },
  }));
}

function mountMenu(labels: string[], log: string[]): Hdom {
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  render(<Menu label="actions for demo" items={menuItems(labels, log)} />, container);
  return container as unknown as Hdom;
}

describe('Menu keyboard contract', () => {
  test('Enter opens from the trigger and focuses the first item; aria state follows', async () => {
    win = installDom();
    const log: string[] = [];
    const host = mountMenu(['Move to Todo', 'Delete…'], log);
    const trigger = host.querySelector('.menu-btn') as unknown as Hdom;
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.focus();
    press(win, trigger, 'Enter');
    await new Promise((resolve) => setTimeout(resolve, 40)); // render + focus effect
    const pop = host.querySelector('.menu-pop') as unknown as Hdom;
    expect(pop).not.toBeNull();
    expect(pop.getAttribute('role')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const first = host.querySelectorAll('.menu-item')[0] as unknown as Hdom;
    expect(first.getAttribute('role')).toBe('menuitem');
    expect(win.document.activeElement).toBe(first);
    expect(log).toEqual([]); // opening selects nothing
  });

  test('Space opens too; ArrowDown/ArrowUp cycle through the items', async () => {
    win = installDom();
    const log: string[] = [];
    const host = mountMenu(['Move to Todo', 'Edit title…', 'Delete…'], log);
    const trigger = host.querySelector('.menu-btn') as unknown as Hdom;
    trigger.focus();
    press(win, trigger, ' ');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const items = [...host.querySelectorAll('.menu-item')] as unknown as Hdom[];
    expect(win.document.activeElement).toBe(items[0]);
    press(win, items[0], 'ArrowDown');
    expect(win.document.activeElement).toBe(items[1]);
    press(win, items[1], 'ArrowDown');
    expect(win.document.activeElement).toBe(items[2]);
    press(win, items[2], 'ArrowDown');
    expect(win.document.activeElement).toBe(items[0]); // wraps
    press(win, items[0], 'ArrowUp');
    expect(win.document.activeElement).toBe(items[2]); // wraps back
    expect(log).toEqual([]);
  });

  test('Escape closes and restores focus to the trigger', async () => {
    win = installDom();
    const log: string[] = [];
    const host = mountMenu(['Move to Todo', 'Delete…'], log);
    const trigger = host.querySelector('.menu-btn') as unknown as Hdom;
    trigger.focus();
    press(win, trigger, 'ArrowDown');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(host.querySelector('.menu-pop')).not.toBeNull();
    press(win, win.document.activeElement as unknown as Hdom, 'Escape');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(host.querySelector('.menu-pop')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(win.document.activeElement).toBe(trigger);
    expect(log).toEqual([]); // Escape never selects
  });

  test('selecting an item closes the menu before running the action, restores the trigger', async () => {
    win = installDom();
    const log: string[] = [];
    const host = mountMenu(['Move to Todo', 'Delete…'], log);
    const trigger = host.querySelector('.menu-btn') as unknown as Hdom;
    trigger.focus();
    press(win, trigger, 'Enter');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = host.querySelectorAll('.menu-item')[1] as unknown as Hdom;
    second.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(log).toContain('select:Delete…');
    expect(log).toContain('menu-open-at-select:false'); // closed BEFORE onSelect ran
    expect(host.querySelector('.menu-pop')).toBeNull();
    expect(win.document.activeElement).toBe(trigger);
  });

  test('menu clicks never leak to an ancestor interactive container', async () => {
    win = installDom();
    const log: string[] = [];
    const wrapper = win.document.createElement('div');
    let ancestorClicks = 0;
    wrapper.addEventListener('click', () => {
      ancestorClicks += 1;
    });
    win.document.body.appendChild(wrapper);
    render(<Menu label="actions for demo" items={menuItems(['Move to Todo'], log)} />, wrapper);
    const trigger = wrapper.querySelector('.menu-btn') as unknown as Hdom;
    trigger.click(); // pointer open
    await new Promise((resolve) => setTimeout(resolve, 40));
    const item = wrapper.querySelectorAll('.menu-item')[0] as unknown as Hdom;
    item.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(log).toContain('select:Move to Todo');
    expect(ancestorClicks).toBe(0); // a menu action must not also open the card
  });

  test('pointer open renders every item with its label', async () => {
    win = installDom();
    const log: string[] = [];
    const host = mountMenu(['Move to Groomed', 'Edit groom…', 'Delete…'], log);
    const trigger = host.querySelector('.menu-btn') as unknown as Hdom;
    trigger.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const labels = [...host.querySelectorAll('.menu-item')].map((el) => el.textContent);
    expect(labels).toEqual(['Move to Groomed', 'Edit groom…', 'Delete…']);
  });
});

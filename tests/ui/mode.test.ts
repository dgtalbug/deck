import { describe, expect, test } from 'bun:test';
import { currentMode, isLoopbackHost, setMode, toggleMode } from '../../src/ui/slices/board/mode.ts';
import { installDom } from './dom.ts';

describe('mode', () => {
  test('toggle round-trips and the spade:mode event fires', () => {
    const win = installDom();
    const fired: string[] = [];
    win.document.addEventListener('spade:mode', (event) => {
      fired.push((event as unknown as CustomEvent<string>).detail);
    });

    expect(currentMode()).toBe('dark'); // shell default
    toggleMode();
    expect(currentMode()).toBe('light');
    expect(win.document.documentElement.dataset.mode).toBe('light');
    expect(win.localStorage.getItem('deck-mode')).toBe('light');
    expect(fired).toEqual(['light']);

    toggleMode();
    expect(currentMode()).toBe('dark');
    expect(win.localStorage.getItem('deck-mode')).toBe('dark');
    expect(fired).toEqual(['light', 'dark']);

    setMode('light');
    expect(currentMode()).toBe('light');
    expect(fired).toEqual(['light', 'dark', 'light']);
  });

  test('loopback hostname detection', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('192.168.1.20')).toBe(false);
    expect(isLoopbackHost('deck.lan')).toBe(false);
  });
});

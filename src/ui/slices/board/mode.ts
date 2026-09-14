
export type Mode = 'dark' | 'light';

const STORAGE_KEY = 'deck-mode';

export function currentMode(): Mode {
  return document.documentElement.dataset.mode === 'light' ? 'light' : 'dark';
}

export function setMode(mode: Mode): void {
  document.documentElement.dataset.mode = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
  }
  document.dispatchEvent(new CustomEvent<Mode>('spade:mode', { detail: mode }));
}

export function toggleMode(): void {
  setMode(currentMode() === 'dark' ? 'light' : 'dark');
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function exposedHost(): boolean {
  return typeof window !== 'undefined' && !isLoopbackHost(window.location.hostname);
}

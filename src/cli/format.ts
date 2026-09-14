
export const GRID = 72;
export const TITLE_COLS = 44;

export function pad(text: string, n: number): string {
  return (text + ' '.repeat(n)).slice(0, Math.max(n, text.length));
}

export function padLeft(text: string, n: number): string {
  return (' '.repeat(n) + text).slice(-Math.max(n, text.length));
}

export function rule(n: number): string {
  return '─'.repeat(n);
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp >= 0x0300 && cp <= 0x036f) continue; 
    if (
      (cp >= 0x1100 && cp <= 0x115f) || 
      (cp >= 0x2e80 && cp <= 0x303e) || 
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || 
      (cp >= 0xf900 && cp <= 0xfaff) || 
      (cp >= 0xfe30 && cp <= 0xfe4f) || 
      (cp >= 0xff00 && cp <= 0xff60) || 
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)  
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function truncateTitle(title: string, max = TITLE_COLS, dumb = false): string {
  const ellipsis = dumb ? '~' : '…';
  if (displayWidth(title) <= max) return pad(title, max);
  let used = 0;
  let cut = 0;
  for (const char of title) {
    const cp = char.codePointAt(0)!;
    const w = cp >= 0x0300 && cp <= 0x036f ? 0 : displayWidth(char);
    if (used + w > max - 1) break;
    used += w;
    cut += char.length;
  }
  return title.slice(0, cut) + ' '.repeat(Math.max(0, max - used - 1)) + ellipsis;
}

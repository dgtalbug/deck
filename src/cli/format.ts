// 72-column output grid (Deck CLI Identity §3–§4): left rule only, ragged
// right, width-safe truncation. Column law: 2sp · id(6) · 2sp · title(≤44) ·
// right-aligned chip + progress ending at col 72.

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

// wcwidth semantics, reduced to what generated output + realistic titles can
// contain: combining marks 0, W/F (CJK + full-width forms) 2, else 1
// (ambiguous counts 1). Anything unmeasured degrades to 1 — safe under the
// ragged-right law (trailing shift only, never a broken border).
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp >= 0x0300 && cp <= 0x036f) continue; // combining marks
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals…Yi
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
      (cp >= 0xff00 && cp <= 0xff60) || // full-width forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)  // CJK ext B+
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

// Cut at the last glyph that fits within max−1 columns (backing off one
// glyph rather than splitting a width-2 glyph), pad, and place the ellipsis
// at col max. ASCII `~` under TERM=dumb.
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

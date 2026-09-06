// ASCII card-stack banner (Deck CLI Identity §2): three stacked cards, the
// top card carrying the spade pip. Lime lands on the pip and the version —
// never the borders. Art is exact strings from the artifact set.

import { type Palette } from './color.ts';
import { BOARD_DB_NAME } from '../core/board/store.ts';
import { DEFAULT_PORT } from '../server/config.ts';

const BANNER_ASCII = [
  '+--------+',
  '|  +--------+',
  '|  |  +--------+',
  '|  |  |   ##   |       d e c k   v0.2.0',
  '+--|  |  ####  |       spec-driven engine for coding agents',
  '   +--| ###### |       the control deck deals in spades',
  '      |   ##   |',
  '      +--------+',
];

const BANNER_BOX = [
  '╭────────╮',
  '│  ╭────────╮',
  '│  │  ╭────────╮',
  '│  │  │   ██   │       deck v0.2.0',
  '╰──┤  │ ██████ │       spec-driven engine for coding agents',
  '   ╰──┤████████│       the control deck deals in spades',
  '      │   ██   │',
  '      ╰────────╯',
];

// The pip (front-card interior) occupies 8 columns starting at the cut on
// lines 3–6 of both variants; everything else stays muted.
function renderBanner(lines: string[], version: string, p: Palette): string {
  return lines
    .map((line, i) => {
      if (i < 3 || i > 6) return p.dim(line);
      // front-card border is the first border glyph at/after col 6; the pip
      // occupies the 8 columns that follow it
      const match = /[|│┤]/.exec(line.slice(6));
      const cut = 6 + (match ? (match.index ?? 0) : 0) + 1;
      const inner = line.slice(cut, cut + 8);
      const rest = line.slice(cut + 8);
      const border = rest.slice(0, 1);
      let tail = p.dim(rest.slice(1));
      if (i === 3) {
        // title line: name bold, version dim (never lime)
        tail = `       ${p.bold('deck')} ${p.dim(`v${version}`)}`;
      }
      return `${p.dim(line.slice(0, cut))}${p.bold(p.color('primary', inner))}${p.dim(border)}${tail}`;
    })
    .join('\n');
}

export function bannerAscii(version: string, p: Palette): string {
  return renderBanner(BANNER_ASCII.map((l) => l.replace('v0.2.0', `v${version}`)), version, p);
}

export function bannerBox(version: string, p: Palette): string {
  return renderBanner(BANNER_BOX.map((l) => l.replace('v0.2.0', `v${version}`)), version, p);
}

// Facts the compact banner prints (board URL, data path) — derived from the
// shared resolution, never a second hardcoded copy, so they cannot drift.
// Callers that know the real values (serve startup) pass them; the default
// resolves env port → default, same order as the server.
export interface BannerFacts {
  boardUrl: string;
  dataPath: string;
}

export function defaultBannerFacts(env: Record<string, string | undefined> = {}): BannerFacts {
  const envPort = Number.parseInt(env['DECK_PORT'] ?? '', 10);
  const port = Number.isNaN(envPort) ? DEFAULT_PORT : envPort;
  return { boardUrl: `http://127.0.0.1:${port}`, dataPath: `.deck/${BOARD_DB_NAME}` };
}

export function bannerCompact(
  version: string,
  p: Palette,
  facts: BannerFacts = defaultBannerFacts(),
): string {
  return [
    `${p.bold(p.color('primary', '♠'))} ${p.bold('deck')} ${p.dim(`v${version}`)} · local-first spec engine for coding agents`,
    `  ${p.dim('board')} ${facts.boardUrl}  ${p.dim(`·  data ${facts.dataPath}`)}`,
    `  ${p.dim('less text, more work')}`,
  ].join('\n');
}

export type BannerKind = 'ascii' | 'box' | 'compact';

// Selection law: compact under the size guard; box-drawing when the locale
// reports UTF-8 and color is on; strict ASCII otherwise.
export function pickBanner(opts: {
  locale: string;
  level: 'off' | '16' | '256' | '24bit';
  cols: number;
  rows: number;
}): BannerKind {
  if (opts.rows < 12 || opts.cols < 56) return 'compact';
  const utf8 = /UTF-8/i.test(opts.locale);
  if (utf8 && opts.level !== 'off') return 'box';
  return 'ascii';
}

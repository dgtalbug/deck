// Terminal color law (Deck CLI Identity §1): color is information, never
// decoration; foreground SGR only; muted scale rides dim/bold, not greys.
// Codes transcribed from the locked artifact set — do not retune here.

export type Level = 'off' | '16' | '256' | '24bit';

// Detection order is the contract (spec: cli/identity). FORCE_COLOR=1
// overrides the isatty check only.
export function detectLevel(
  env: Record<string, string | undefined>,
  isatty: boolean,
): Level {
  if ((env['NO_COLOR'] ?? '') !== '') return 'off';
  const forced = env['FORCE_COLOR'] === '1';
  if (!isatty && !forced) return 'off';
  if (env['TERM'] === 'dumb') return 'off';
  const colorterm = env['COLORTERM'] ?? '';
  if (colorterm === 'truecolor' || colorterm === '24bit') return '24bit';
  if ((env['TERM'] ?? '').includes('256color')) return '256';
  return '16';
}

type Codes = { tc: string; c256: string; c16: string };

// vivid collapses to bold lime below truecolor; the rest keep their hue.
const TOKENS = {
  primary: { tc: '38;2;159;225;24', c256: '38;5;154', c16: '92' },
  vivid: { tc: '38;2;174;242;39', c256: '38;5;154;1', c16: '92;1' },
  success: { tc: '38;2;74;222;128', c256: '38;5;79', c16: '32' },
  warning: { tc: '38;2;251;191;36', c256: '38;5;214', c16: '33' },
  danger: { tc: '38;2;248;113;113', c256: '38;5;203', c16: '91' },
  services: { tc: '38;2;138;184;255', c256: '38;5;111', c16: '94' },
  async: { tc: '38;2;34;211;238', c256: '38;5;45', c16: '96' },
  external: { tc: '38;2;244;114;182', c256: '38;5;205', c16: '95' },
} as const satisfies Record<string, Codes>;

export type Token = keyof typeof TOKENS;

const RESET = '\x1b[0m';

export interface Palette {
  level: Level;
  color(token: Token, text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

// off = identity functions: output stays byte-identical with color stripped.
export function palette(level: Level): Palette {
  if (level === 'off') {
    return {
      level,
      color: (_token, text) => text,
      dim: (text) => text,
      bold: (text) => text,
    };
  }
  const code = (token: Token): string => {
    const codes = TOKENS[token];
    return level === '24bit' ? codes.tc : level === '256' ? codes.c256 : codes.c16;
  };
  return {
    level,
    color: (token, text) => `\x1b[${code(token)}m${text}${RESET}`,
    dim: (text) => `\x1b[2m${text}${RESET}`,
    bold: (text) => `\x1b[1m${text}${RESET}`,
  };
}

export function stripSgr(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

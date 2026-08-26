// Hand-rolled arg parsing (design D2): commands, `--flag value`,
// `--flag=value`, boolean flags, `--` passthrough. No commander/yargs —
// stack law, zero new deps.

export type FlagValue = string | true | string[];

export interface ParsedArgs {
  // First non-flag token, when present.
  command?: string;
  positionals: string[];
  flags: Record<string, FlagValue>;
  // Everything after `--`, verbatim.
  passthrough: string[];
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function isFlag(token: string): boolean {
  return token.startsWith('--') && token.length > 2;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], flags: {}, passthrough: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      parsed.passthrough.push(...argv.slice(i + 1));
      return parsed;
    }
    if (!isFlag(token)) {
      if (parsed.command === undefined) parsed.command = token;
      else parsed.positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    let name: string;
    let inline: string | undefined;
    if (eq >= 0) {
      name = token.slice(2, eq);
      inline = token.slice(eq + 1);
    } else {
      name = token.slice(2);
    }
    if (name.length === 0) throw new UsageError(`empty flag name in '${token}'`);
    if (inline !== undefined) {
      setFlag(parsed.flags, name, inline);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !isFlag(next) && next !== '--') {
      setFlag(parsed.flags, name, next);
      i += 1;
    } else {
      // No consumable value: boolean flag.
      setFlag(parsed.flags, name, true);
    }
  }
  return parsed;
}

// Repeated flags accumulate into arrays (e.g. `verify --task a --task b`).
function setFlag(flags: Record<string, FlagValue>, name: string, value: string | true): void {
  const existing = flags[name];
  if (existing === undefined) {
    flags[name] = value;
    return;
  }
  const arr: string[] = Array.isArray(existing) ? existing : existing === true ? [] : [existing];
  if (value !== true) arr.push(value);
  flags[name] = arr;
}

// Convenience readers used by the dispatch table.
export function flagString(flags: Record<string, FlagValue>, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined || value === true) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

export function flagStrings(flags: Record<string, FlagValue>, name: string): string[] {
  const value = flags[name];
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

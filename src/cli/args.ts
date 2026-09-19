
export type FlagValue = string | true | string[];

export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, FlagValue>;
  passthrough: string[];
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface FlagSpec {
  [flag: string]: 'boolean' | 'value' | 'repeat';
}

export interface ParseOptions {
  // Resolves the flag spec for a command once its first token is known; a
  // missing entry falls back to permissive legacy parsing (dynamic user
  // verbs, internal calls) rather than inventing a contract.
  specFor?: (command: string) => FlagSpec | undefined;
}

function isFlag(token: string): boolean {
  return token.startsWith('--') && token.length > 2;
}

export function parseArgs(argv: string[], options: ParseOptions = {}): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], flags: {}, passthrough: [] };
  let spec: FlagSpec | undefined;
  let i = 0;
  for (; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      parsed.passthrough.push(...argv.slice(i + 1));
      return parsed;
    }
    if (!isFlag(token)) {
      if (parsed.command === undefined) {
        parsed.command = token;
        spec = options.specFor?.(token);
      } else {
        parsed.positionals.push(token);
      }
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
    // Unknown flags on a manifested command are usage errors before effects.
    if (spec !== undefined && !(name in spec)) {
      const known = Object.keys(spec).map((flag) => `--${flag}`).join(', ');
      throw new UsageError(`unknown flag --${name} for '${parsed.command}'${known.length > 0 ? ` — known flags: ${known}` : ' (this command takes no flags)'}`);
    }
    const kind = spec?.[name];
    if (kind === 'boolean') {
      if (inline !== undefined) {
        throw new UsageError(`--${name} is a boolean flag — write it without a value`);
      }
      setFlag(parsed.flags, name, true, kind);
      continue;
    }
    // Value and repeat flags consume the next token; only legacy-unspec'd
    // flags may fall back to a boolean form.
    if (inline !== undefined) {
      setFlag(parsed.flags, name, inline, kind);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !isFlag(next) && next !== '--') {
      setFlag(parsed.flags, name, next, kind);
      i += 1;
    } else if (kind === 'value' || kind === 'repeat') {
      throw new UsageError(`--${name} requires a value`);
    } else {
      setFlag(parsed.flags, name, true, kind);
    }
  }
  return parsed;
}

function setFlag(flags: Record<string, FlagValue>, name: string, value: string | true, kind?: 'boolean' | 'value' | 'repeat'): void {
  const existing = flags[name];
  if (kind === 'value' && existing !== undefined) {
    throw new UsageError(`--${name} may only be given once`);
  }
  if (existing === undefined) {
    flags[name] = value;
    return;
  }
  const arr: string[] = Array.isArray(existing) ? existing : existing === true ? [] : [existing];
  if (value !== true) arr.push(value);
  flags[name] = arr;
}

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

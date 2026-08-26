import { DeckError } from '../core/board/errors.ts';
import { readDeckConfig } from '../core/board/config.ts';

export const DEFAULT_PORT = 3325;

export class ConfigError extends DeckError {
  constructor(message: string, details: Record<string, unknown>) {
    super(message, details);
  }
}

// Override order locked by the epic: --port flag > server.port config >
// DECK_PORT env > 3325. The config file is the deck project's own
// deck.config.yaml in the server's working directory.
export async function resolvePort(flag?: number): Promise<number> {
  if (flag !== undefined) return flag;
  const config = await readDeckConfig(process.cwd());
  const fromConfig = config.server?.port;
  if (fromConfig !== undefined) return fromConfig;
  const env = process.env['DECK_PORT'];
  if (env !== undefined && env.length > 0) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isNaN(parsed)) {
      throw new ConfigError(`DECK_PORT '${env}' is not a number`, { env });
    }
    return parsed;
  }
  return DEFAULT_PORT;
}

export interface ServeArgs {
  port?: number;
  host?: string;
}

export function parseServeArgs(argv: string[]): ServeArgs {
  const args: ServeArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new ConfigError('--port needs a value', { argv });
      }
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed)) {
        throw new ConfigError(`--port '${value}' is not a number`, { value });
      }
      args.port = parsed;
      i += 1;
    } else if (argv[i] === '--host') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new ConfigError('--host needs a value', { argv });
      }
      args.host = value;
      i += 1;
    }
  }
  return args;
}

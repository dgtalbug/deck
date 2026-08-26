import type { Server } from 'bun';
import { ProjectRegistry } from '../core/projects/registry.ts';
import { DEFAULT_PORT, parseServeArgs, resolvePort } from './config.ts';
import { boardRoutes } from './routes/board.ts';
import { cardsRoutes } from './routes/cards.ts';
import { gitRoutes } from './routes/git.ts';
import { homeRoutes } from './routes/home.ts';
import { notesRoutes } from './routes/notes.ts';
import { sseRoutes } from './sse.ts';
import { openApiRoutes } from './openapi.ts';
import { handleError, type RouteTable } from './http.ts';
import { withPages, type EmbeddedLookup } from './static.ts';

export interface BuildOptions {
  port?: number;
  hostname?: string;
  registry?: ProjectRegistry;
  // Root owning public/ and dist/ for the UI shell; defaults to cwd.
  staticRoot?: string;
  // Embedded asset source override (tests); defaults to the compiled-in map.
  embedded?: EmbeddedLookup;
}

export function buildRoutes(registry: ProjectRegistry, staticRoot?: string, embedded?: EmbeddedLookup): RouteTable {
  const routes: RouteTable = {
    ...openApiRoutes,
    ...homeRoutes(registry),
    ...boardRoutes(registry),
    ...notesRoutes(registry),
    ...cardsRoutes(registry),
    ...gitRoutes(registry),
    ...(DECK_FEATURE_SSE ? sseRoutes(registry) : {}),
  };
  return withPages(routes, staticRoot ?? process.cwd(), embedded);
}

export function buildServer(options: BuildOptions = {}): Server<undefined> {
  const registry = options.registry ?? new ProjectRegistry();
  return Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? '127.0.0.1',
    routes: buildRoutes(registry, options.staticRoot, options.embedded),
    error(error) {
      return handleError(error);
    },
  });
}

async function main(): Promise<void> {
  const args = parseServeArgs(process.argv.slice(2));
  const port = await resolvePort(args.port);
  try {
    const server = buildServer({ port, hostname: args.host ?? '127.0.0.1' });
    console.log(`deck serving on http://${server.hostname}:${server.port}`);
  } catch (error) {
    // Port collisions fail loudly with a suggestion — never a silent bump.
    console.error(
      `\ndeck: cannot listen on port ${port} — it is already in use.\n` +
        `Hint: another deck server may be running (try \`lsof -i :${port}\`), ` +
        `stop it or start this one with \`--port ${port + 1}\`.\n` +
        `Cause: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}

export { DEFAULT_PORT };

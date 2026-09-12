import type { Server } from 'bun';
import { ProjectRegistry } from '../core/projects/registry.ts';
import { DECK_VERSION } from '../version.ts';
import { bannerAscii, bannerBox, bannerCompact, defaultBannerFacts, pickBanner } from '../cli/banner.ts';
import { detectLevel, palette } from '../cli/color.ts';
import { DEFAULT_PORT, parseServeArgs, resolvePort } from './config.ts';
import { boardRoutes } from './routes/board.ts';
import { cardsRoutes } from './routes/cards.ts';
import { engineRoutes } from './routes/engine.ts';
import { epicsRoutes } from './routes/epics.ts';
import { gitRoutes } from './routes/git.ts';
import { homeRoutes } from './routes/home.ts';
import { notesRoutes } from './routes/notes.ts';
import { specsRoutes } from './routes/specs.ts';
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
    ...specsRoutes(registry),
    ...engineRoutes(registry),
    ...epicsRoutes(registry),
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

// The banner block printed above the serving line at startup (identity §2):
// the existing selection law picks the variant; facts carry the port this
// server actually resolved. Injected env/size for tests; defaults are real.
export function startupBanner(opts: {
  port: number;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
  cols?: number;
  rows?: number;
}): string {
  const env = opts.env ?? Bun.env;
  const level = detectLevel(env, opts.isTTY ?? Boolean(process.stdout.isTTY));
  const kind = pickBanner({
    locale: env['LANG'] ?? env['LC_ALL'] ?? '',
    level,
    cols: opts.cols ?? process.stdout.columns ?? Number.POSITIVE_INFINITY,
    rows: opts.rows ?? process.stdout.rows ?? Number.POSITIVE_INFINITY,
  });
  const p = palette(level);
  if (kind === 'compact') {
    // facts state the port this server bound (flag > config > env > default),
    // not a re-derivation — a config port can never disagree with the banner.
    const facts = {
      boardUrl: `http://127.0.0.1:${opts.port}`,
      dataPath: defaultBannerFacts(env).dataPath,
    };
    return bannerCompact(DECK_VERSION, p, facts);
  }
  return kind === 'box' ? bannerBox(DECK_VERSION, p) : bannerAscii(DECK_VERSION, p);
}

// Non-loopback bind = the board AND its git routes accept unauthenticated
// writes from anyone who can reach the interface. Null on loopback.
export function nonLoopbackWarning(host: string): string | null {
  if (['127.0.0.1', 'localhost', '::1'].includes(host)) return null;
  return (
    `\n  WARNING: binding to ${host} — the board and its git routes accept\n` +
    `  UNAUTHENTICATED writes from anyone on that interface.\n` +
    `  Keep --host loopback unless you know the network is trusted.\n`
  );
}

export async function serveMain(): Promise<void> {
  const args = parseServeArgs(process.argv.slice(2));
  const port = await resolvePort(args.port);
  try {
    const server = buildServer({ port, hostname: args.host ?? '127.0.0.1' });
    // Non-loopback bind = the board AND its git routes accept unauthenticated
    // writes from anyone who can reach the interface. Warn before listening.
    const warning = nonLoopbackWarning(server.hostname ?? '127.0.0.1');
    if (warning !== null) console.error(warning);
    console.log(startupBanner({ port: server.port ?? port }));
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
  void serveMain();
}

export { DEFAULT_PORT };

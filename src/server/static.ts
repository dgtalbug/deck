import type { BunRequest } from 'bun';
import { resolve, sep } from 'node:path';
import type { RouteHandler, RouteTable } from './http.ts';

// Static serving for the board UI (add-ui-dashboard design D1): the built
// shell (public/index.html) is served for exactly the epic's two page paths
// and its assets under the reserved /ui prefix. Every API route stays
// untouched; GET / keeps returning JSON unless the client asks for an HTML
// page — browser navigation sends "Accept: text/html", curl/fetch do not.

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function acceptsHtml(req: BunRequest): boolean {
  const accept = req.headers.get('accept') ?? '';
  return accept.includes('text/html');
}

// UI assets embedded at compile time (scripts/embed-ui.ts). Disk wins when
// present (dev checkout, test fixtures); the embedded map is what a
// standalone `deck` binary serves. Undefined until the first lookup.
let embeddedCache: Record<string, string> | null | undefined;

async function embeddedAssets(): Promise<Record<string, string> | null> {
  if (embeddedCache !== undefined) return embeddedCache;
  try {
    embeddedCache = (await import('./ui-assets')).uiAssets;
  } catch {
    embeddedCache = null; // fresh clone before build:ui — disk-only mode
  }
  return embeddedCache;
}

// Injectable so tests stay hermetic regardless of build state; production
// uses the compiled-in module loader.
export type EmbeddedLookup = () => Promise<Record<string, string> | null>;

async function embeddedResponse(
  path: string,
  lookup: EmbeddedLookup = embeddedAssets,
): Promise<Response | undefined> {
  const assets = await lookup();
  const content = assets?.[path];
  if (content === undefined) return undefined;
  // '/' (the shell) has no extension — it is always HTML
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '.html' : path.slice(dot);
  return new Response(content, {
    headers: {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    },
  });
}

async function serveFile(
  root: string,
  relative: string,
): Promise<Response | undefined> {
  // Containment first: resolve before touching the filesystem so /ui/* can
  // never escape dist/ui (D-UI-009 trust boundary).
  const base = resolve(root);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep)) return undefined;
  const file = Bun.file(target);
  if (!(await file.exists())) return undefined;
  const dot = target.lastIndexOf('.');
  const ext = dot === -1 ? '' : target.slice(dot);
  return new Response(file, {
    headers: {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      // Everything revalidates: the entry chunk keeps its name across
      // rebuilds, so any max-age would serve stale UI after a rebuild.
      'cache-control': 'no-cache',
    },
  });
}

// Page handler for GET / and GET /:project/ — HTML for browsers, existing
// JSON behavior for everything else. Shell lookup: disk first (dev/tests),
// then the embedded copy baked into compiled binaries.
export function pageHandler(
  root: string,
  fallback?: RouteHandler,
  embedded: EmbeddedLookup = embeddedAssets,
): RouteHandler {
  return async (req, server) => {
    if (acceptsHtml(req)) {
      const shell = (await serveFile(root, 'public/index.html')) ?? (await embeddedResponse('/', embedded));
      if (shell !== undefined) return shell;
    }
    if (fallback === undefined) {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    return fallback(req, server);
  };
}

export function staticRoutes(root: string, embedded: EmbeddedLookup = embeddedAssets): RouteTable {
  return {
    '/ui/*': {
      GET: async (req) => {
        // Bun 1.4 does not expose wildcard params — slice the URL instead.
        const path = decodeURIComponent(new URL(req.url).pathname);
        const relative = path.replace(/^\/ui\/?/, '');
        if (relative === '') {
          return Response.json({ error: 'asset not found' }, { status: 404 });
        }
        const asset =
          (await serveFile(resolve(root, 'dist', 'ui'), relative)) ??
          (await embeddedResponse(`/ui/${relative}`, embedded));
        return asset ?? Response.json({ error: 'asset not found' }, { status: 404 });
      },
    },
  };
}

export function withPages(
  routes: RouteTable,
  root: string,
  embedded: EmbeddedLookup = embeddedAssets,
): RouteTable & Record<'/' | '/:project/', { GET: RouteHandler }> {
  return {
    ...routes,
    ...staticRoutes(root, embedded),
    '/': { GET: pageHandler(root, routes['/']?.GET, embedded) },
    '/:project/': { GET: pageHandler(root, undefined, embedded) },
  };
}

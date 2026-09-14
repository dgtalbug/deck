import type { BunRequest } from 'bun';
import { resolve, sep } from 'node:path';
import type { RouteHandler, RouteTable } from './http.ts';

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

let embeddedCache: Record<string, string> | null | undefined;

async function embeddedAssets(): Promise<Record<string, string> | null> {
  if (embeddedCache !== undefined) return embeddedCache;
  try {
    embeddedCache = (await import('./ui-assets')).uiAssets;
  } catch {
    embeddedCache = null; 
  }
  return embeddedCache;
}

export type EmbeddedLookup = () => Promise<Record<string, string> | null>;

async function embeddedResponse(
  path: string,
  lookup: EmbeddedLookup = embeddedAssets,
): Promise<Response | undefined> {
  const assets = await lookup();
  const content = assets?.[path];
  if (content === undefined) return undefined;
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
      'cache-control': 'no-cache',
    },
  });
}

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
  const iconRoute = (name: string): RouteHandler => async () =>
    (await serveFile(root, `public/${name}`)) ??
    (await embeddedResponse(`/${name}`, embedded)) ??
    Response.json({ error: 'not found' }, { status: 404 });
  return {
    '/favicon.svg': { GET: iconRoute('favicon.svg') },
    '/favicon-16.svg': { GET: iconRoute('favicon-16.svg') },
    '/icon-maskable.svg': { GET: iconRoute('icon-maskable.svg') },
    '/ui/*': {
      GET: async (req) => {
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

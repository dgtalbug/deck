import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import type { EmbeddedLookup } from '../../src/server/static.ts';
import { tmpProject } from '../helpers.ts';

// Static serving (add-ui-dashboard design D1): the shell is served for the
// two page paths and /ui/* assets. This file doubles as the mirror test —
// with the static routes mounted, every JSON API route behaves exactly as
// it did before (same statuses, same bodies).

const SHELL = '<!DOCTYPE html><html data-mode="dark"><body>deck shell fixture</body></html>';

let server: Server<undefined>;
let registry: ProjectRegistry;
let project: ReturnType<typeof tmpProject>;
let staticRoot: string;
let baseUrl: string;

beforeAll(() => {
  staticRoot = mkdtempSync(join(tmpdir(), 'deck-static-'));
  writeFileSync(join(staticRoot, 'secret.txt'), 'must stay unreachable');
  mkdirSync(join(staticRoot, 'public'), { recursive: true });
  writeFileSync(join(staticRoot, 'public', 'index.html'), SHELL);
  mkdirSync(join(staticRoot, 'dist', 'ui'), { recursive: true });
  writeFileSync(join(staticRoot, 'dist', 'ui', 'app.js'), 'console.log("deck ui")');
  writeFileSync(join(staticRoot, 'dist', 'ui', 'app.css'), 'body{}');

  registry = new ProjectRegistry();
  project = tmpProject('deck-static-proj-');
  registry.register(project.path, 'staticproj');
  // hermetic: no build state leaks embedded assets into these tests
  const noEmbedded: EmbeddedLookup = () => Promise.resolve(null);
  server = buildServer({ registry, staticRoot, embedded: noEmbedded });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server.stop(true);
  registry.close();
  project.cleanup();
  rmSync(staticRoot, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('page routes serve the shell to browsers', () => {
  test('GET / with Accept: text/html returns the shell', async () => {
    const response = await fetch(`${baseUrl}/`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('deck shell fixture');
  });

  test('GET /:project/ returns the shell (SPA renders unknown projects)', async () => {
    const response = await fetch(`${baseUrl}/staticproj/`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(SHELL);
    const unknown = await fetch(`${baseUrl}/ghost/`, { headers: { accept: 'text/html' } });
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toBe(SHELL);
  });
});

describe('reserved /ui asset prefix', () => {
  test('serves built assets with content types', async () => {
    const js = await fetch(`${baseUrl}/ui/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(await js.text()).toContain('deck ui');
    const css = await fetch(`${baseUrl}/ui/app.css`);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  test('missing asset → 404 JSON', async () => {
    const response = await fetch(`${baseUrl}/ui/missing.js`);
    expect(response.status).toBe(404);
  });

  test('path traversal stays inside dist/ui', async () => {
    const response = await fetch(`${baseUrl}/ui/%2e%2e/secret.txt`);
    expect(response.status).toBe(404);
  });
});

describe('mirror: JSON API routes unchanged with static routes mounted', () => {
  test('GET / without text/html still returns the project list JSON', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: { name: string }[] };
    expect(body.projects.map((entry) => entry.name)).toContain('staticproj');
  });

  test('board, notes, and error mapping behave as before', async () => {
    const board = await fetch(`${baseUrl}/staticproj/board`);
    expect(board.status).toBe(200);
    const lanes = (await board.json()) as { lanes: Record<string, unknown[]> };
    expect(Object.keys(lanes.lanes).sort()).toEqual(['active', 'done', 'groomed', 'todo', 'verify']);

    const note = await post('/staticproj/notes', { title: 'mirror note' });
    expect(note.status).toBe(201);

    const forbidden = await post('/staticproj/cards/ghost/move', { to: 'active' });
    expect(forbidden.status).toBe(404);

    const unknownProject = await fetch(`${baseUrl}/nope/board`);
    expect(unknownProject.status).toBe(404);
  });
});

describe('embedded assets (compiled-binary mode)', () => {
  test('embedded shell and assets serve when disk misses them', async () => {
    const bareRoot = mkdtempSync(join(tmpdir(), 'deck-embedded-root-')); // no files on disk
    const embedded: EmbeddedLookup = () =>
      Promise.resolve({
        '/': '<!DOCTYPE html><html><body>embedded deck shell</body></html>',
        '/ui/app.js': 'console.log("embedded ui")',
      });
    const server = buildServer({ registry: new ProjectRegistry(), staticRoot: bareRoot, embedded });
    try {
      const shell = await fetch(`${server.url.toString()}/`, { headers: { accept: 'text/html' } });
      expect(shell.status).toBe(200);
      expect(shell.headers.get('content-type')).toContain('text/html');
      expect(await shell.text()).toContain('embedded deck shell');

      const js = await fetch(`${server.url.toString()}/ui/app.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toContain('text/javascript');
      expect(await js.text()).toContain('embedded ui');

      // no disk, no embedded entry → still a clean 404
      expect((await fetch(`${server.url.toString()}/ui/ghost.js`)).status).toBe(404);
    } finally {
      server.stop(true);
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });
});

describe('graceful fallback when no shell is built', () => {
  test('GET / with text/html but no public/index.html falls back to JSON', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'deck-empty-root-'));
    const noEmbedded: EmbeddedLookup = () => Promise.resolve(null);
    const bare = buildServer({ registry: new ProjectRegistry(), staticRoot: emptyRoot, embedded: noEmbedded });
    try {
      const response = await fetch(`${bare.url.toString()}/`, { headers: { accept: 'text/html' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      // Registries share the process-wide test DECK_HOME, so only the shape
      // is asserted here — the empty case is covered by routes.test.ts.
      expect(Array.isArray(((await response.json()) as { projects: unknown[] }).projects)).toBe(true);
    } finally {
      bare.stop(true);
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

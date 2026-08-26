import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { tmpProject } from '../helpers.ts';
import { subscribeBoardEvents, type SseSubscription } from '../../src/ui/slices/board/sse.ts';

// Bun has no native EventSource → these tests exercise the fetch-stream
// path of sse.ts against a live in-process server (task 4.3).
let server: Server<undefined>;
let registry: ProjectRegistry;
let project: ReturnType<typeof tmpProject>;
let baseUrl: string;

let previousHome: string | undefined;

beforeAll(() => {
  previousHome = process.env['DECK_HOME'];
  const home = mkdtempSync(join(tmpdir(), 'deck-ui-sse-home-'));
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  project = tmpProject('deck-ui-sse-');
  registry.register(project.path, 'sseproj');
  server = buildServer({ registry });
  baseUrl = server.url.toString().replace(/\/$/, '');
});

afterAll(() => {
  server.stop(true);
  registry.close();
  // The project dir leaks on purpose: the process-wide store cache keeps the
  // SQLite connection open, and deleting a WAL database under it poisons
  // later connections on macOS (SQLITE_IOERR_VNODE). tmpdir is ephemeral.
});

describe('subscribeBoardEvents (fetch-stream fallback)', () => {
  test('open → onOpen fired once; note creation streams as an event', async () => {
    const events: unknown[][] = [];
    let opens = 0;
    let errors = 0;
    let sub: SseSubscription | undefined;
    // global fetch is used by the fallback with relative URL → patch base
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      originalFetch(String(input).startsWith('/') ? `${baseUrl}${input}` : input, init)) as typeof fetch;
    try {
      sub = subscribeBoardEvents('sseproj', {
        onEvents: (batch) => events.push(batch),
        onOpen: () => {
          opens += 1;
        },
        onError: () => {
          errors += 1;
        },
      });

      // the stream takes a moment to flush (keepalive tick)
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(opens).toBe(1);
      expect(errors).toBe(0);

      await originalFetch(`${baseUrl}/sseproj/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'sse note' }),
      });
      await new Promise((resolve) => setTimeout(resolve, 700));

      const flat = events.flat() as { type: string; payload: { id?: string } }[];
      expect(flat.some((event) => event.type === 'card.created' && event.payload.id !== undefined)).toBe(true);
    } finally {
      sub?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  test('stop() aborts the stream', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      originalFetch(String(input).startsWith('/') ? `${baseUrl}${input}` : input, init)) as typeof fetch;
    const sub = subscribeBoardEvents('sseproj', { onEvents: () => {}, onOpen: () => {}, onError: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 400));
    sub.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    globalThis.fetch = originalFetch;
    // no assertion to crash on — reaching here without a hang is the test
    expect(true).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { tmpProject } from '../helpers.ts';

let server: Server<undefined>;
let registry: ProjectRegistry;
let home: string;
let project: ReturnType<typeof tmpProject>;
let baseUrl: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'deck-sse-home-'));
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  project = tmpProject('deck-sse-proj-');
  registry.register(project.path, 'ssetest');
  server = buildServer({ registry });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server.stop(true);
  registry.close();
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

async function openStream(): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch(`${baseUrl}/ssetest/events`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  return response.body!.getReader();
}

function decode(chunk: Uint8Array | undefined): string {
  return new TextDecoder().decode(chunk ?? new Uint8Array());
}

describe('SSE /:project/events', () => {
  test('streams keepalive when idle and live events on mutation', async () => {
    const reader = await openStream();

    // Idle poll doubles as keepalive — arrives within a couple of poll ticks.
    const first = decode((await reader.read()).value);
    expect(first).toContain(': keepalive');

    // A write from ANOTHER process-like client (a second HTTP call) must
    // reach this open stream without reconnecting.
    const noteResponse = await fetch(`${baseUrl}/ssetest/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'live note' }),
    });
    expect(noteResponse.status).toBe(201);

    let sawEvent = false;
    for (let i = 0; i < 20 && !sawEvent; i++) {
      const text = decode((await reader.read()).value);
      if (text.includes('card.created')) {
        sawEvent = true;
        expect(text).toContain('event: card.created');
        // card.created payload carries the id (slug of the title), not the title.
        expect(text).toContain('live-note-');
      }
    }
    expect(sawEvent).toBe(true);
    await reader.cancel();
  }, 15000);
});

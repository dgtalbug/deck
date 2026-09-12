import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { tmpProject } from '../helpers.ts';

// Requirement: SSE cancel removes only the disconnecting subscriber —
// canceling one stream must not silence the others; the tailer tears down
// when the LAST subscriber leaves.
let server: Server<undefined>;
let registry: ProjectRegistry;
let home: string;
let project: ReturnType<typeof tmpProject>;
let baseUrl: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'deck-sse-fanout-home-'));
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  project = tmpProject('deck-sse-fanout-');
  registry.register(project.path, 'fanout');
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
  const response = await fetch(`${baseUrl}/fanout/events`);
  expect(response.status).toBe(200);
  return response.body!.getReader();
}

function decode(chunk: Uint8Array | undefined): string {
  return new TextDecoder().decode(chunk ?? new Uint8Array());
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, rounds = 30): Promise<boolean> {
  for (let i = 0; i < rounds; i++) {
    const text = decode((await reader.read()).value);
    if (text.includes(needle)) return true;
  }
  return false;
}

describe('SSE fan-out', () => {
  test(
    'canceling one subscriber leaves the other receiving events',
    async () => {
      const first = await openStream();
      const second = await openStream();
      // let both subscriptions register before the cancel
      await new Promise((resolve) => setTimeout(resolve, 50));

      await first.cancel(); // the bug: this used to clear ALL subscribers

      const noteResponse = await fetch(`${baseUrl}/fanout/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'still alive' }),
      });
      expect(noteResponse.status).toBe(201);

      expect(await readUntil(second, 'card.created')).toBe(true);
      await second.cancel();
    },
    15000,
  );

  test('after the last subscriber leaves, a new one still gets a fresh tailer', async () => {
    const solo = await openStream();
    await solo.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const reborn = await openStream();
    const noteResponse = await fetch(`${baseUrl}/fanout/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'tailer reborn' }),
    });
    expect(noteResponse.status).toBe(201);
    expect(await readUntil(reborn, 'card.created')).toBe(true);
    await reborn.cancel();
  }, 15000);
});

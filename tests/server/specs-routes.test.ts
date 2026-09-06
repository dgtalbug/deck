import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { getIssueMap, listQueue } from '../../src/core/board/specstore.ts';
import { tmpProject } from '../helpers.ts';

// Task 6.3 — v0.4.0 route contracts: publish (200 mapped / 202 queued
// offline), spec history, sync report, backfill counts, 404/400 errors.
let server: Server<undefined>;
let registry: ProjectRegistry;
let home: string;
let project: ReturnType<typeof tmpProject>;
let binDir: string;
let baseUrl: string;
let prevPath: string | undefined;
let prevGh: string | undefined;

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$2" in
  create) echo "https://github.com/o/r/issues/11" ;;
  edit) echo ok ;;
  view) echo "{\\"number\\":11,\\"state\\":\\"open\\",\\"labels\\":[{\\"name\\":\\"groomed\\"}],\\"url\\":\\"u\\"}" ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
  if (prevGh !== undefined) {
    process.env['DECK_GH_BIN'] = prevGh;
    prevGh = undefined;
  } else {
    delete process.env['DECK_GH_BIN'];
  }
}

function offlineGh(): void {
  prevGh = process.env['DECK_GH_BIN'];
  process.env['DECK_GH_BIN'] = join(binDir, 'nowhere');
}

async function post(path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function groom(title: string): Promise<string> {
  const note = await fetch(`${baseUrl}/testproj/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then((response) => response.json() as Promise<{ id: string }>);
  await post(`/testproj/cards/${note.id}/groom`, {
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['one'],
    openQuestions: [],
  });
  return note.id;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'deck-spec-routes-home-'));
  process.env['DECK_HOME'] = home;
  binDir = mkdtempSync(join(tmpdir(), 'deck-spec-routes-bin-'));
  registry = new ProjectRegistry();
  project = tmpProject('deck-spec-routes-');
  registry.register(project.path, 'testproj');
  server = buildServer({ registry });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server.stop(true);
  registry.close();
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

afterEach(() => {
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
  if (prevGh !== undefined) {
    process.env['DECK_GH_BIN'] = prevGh;
    prevGh = undefined;
  } else {
    delete process.env['DECK_GH_BIN'];
  }
});

describe('spec-store routes (v0.4.0)', () => {
  test('publish maps the issue at 200 when gh is reachable', async () => {
    stubGh();
    const id = await groom('route publish card');
    const response = await post(`/testproj/cards/${id}/publish`);
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as { issueNumber: number; queued: boolean };
    expect(outcome.queued).toBe(false);
    expect(outcome.issueNumber).toBe(11);
    const { openStore } = await import('../../src/core/board/store.ts');
    const store = await openStore(project.path);
    expect(getIssueMap(store, id)?.issueNumber).toBe(11);
  });

  test('publish returns 202 + queued when gh is offline', async () => {
    offlineGh();
    const id = await groom('route offline card');
    const response = await post(`/testproj/cards/${id}/publish`);
    expect(response.status).toBe(202);
    const outcome = (await response.json()) as { queued: boolean };
    expect(outcome.queued).toBe(true);
    const { openStore } = await import('../../src/core/board/store.ts');
    const store = await openStore(project.path);
    expect(listQueue(store).some((entry) => entry.cardId === id)).toBe(true);
  });

  test('spec history returns versions newest-first', async () => {
    const id = await groom('route history card');
    const response = await fetch(`${baseUrl}/testproj/cards/${id}/specs`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { versions: { version: number; checksum: string }[] };
    expect(body.versions.length).toBeGreaterThanOrEqual(1);
    expect(body.versions[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test('publish on unknown card 404s; sync on unknown project 404s', async () => {
    stubGh();
    expect((await post('/testproj/cards/ghost/publish')).status).toBe(404);
    expect((await post('/nope/sync')).status).toBe(404);
  });

  test('sync returns a reconcile report', async () => {
    stubGh();
    const response = await post('/testproj/sync');
    expect(response.status).toBe(200);
    const report = (await response.json()) as { gh: string; drift: unknown[] };
    expect(report.gh).toBe('reachable');
    expect(Array.isArray(report.drift)).toBe(true);
  });

  test('backfill imports + publishes existing main specs, idempotently', async () => {
    stubGh();
    const dir = join(project.path, 'openspec', 'specs', 'route', 'cap');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spec.md'), '# route/cap — test capability\n\n## Purpose\n\nTest.\n');
    const first = (await (await post('/testproj/backfill-specs')).json()) as {
      imported: number;
      published: number;
      skippedExisting: number;
    };
    expect(first.imported).toBe(1);
    expect(first.published).toBe(1);
    const second = (await (await post('/testproj/backfill-specs')).json()) as {
      imported: number;
      skippedExisting: number;
    };
    expect(second.imported).toBe(0);
    expect(second.skippedExisting).toBe(1);
    rmSync(join(project.path, 'openspec'), { recursive: true, force: true });
  });
});

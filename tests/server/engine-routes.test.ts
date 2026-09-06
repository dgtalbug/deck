import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { tmpProject } from '../helpers.ts';

// Task 5.3 — v0.5.0 engine routes: start + archive over HTTP, refusal
// codes, parity extension.
let server: Server<undefined>;
let registry: ProjectRegistry;
let home: string;
let project: ReturnType<typeof tmpProject>;
let binDir: string;
let baseUrl: string;
let prevPath: string | undefined;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: project.path, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/61" ;;
  "issue view") echo "{\\"number\\":61,\\"state\\":\\"OPEN\\",\\"labels\\":[{\\"name\\":\\"groomed\\"}],\\"url\\":\\"u\\"}" ;;
  "issue edit"|"issue close") echo ok ;;
  "pr create") echo "https://github.com/o/r/pull/71" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function groomed(title: string, verb: 'feat' | 'fix' = 'feat'): Promise<string> {
  const store = await openStore(project.path);
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: verb,
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['implement'],
    openQuestions: [],
  });
  return note.id;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'deck-engine-routes-home-'));
  process.env['DECK_HOME'] = home;
  binDir = mkdtempSync(join(tmpdir(), 'deck-engine-routes-bin-'));
  registry = new ProjectRegistry();
  project = tmpProject('deck-engine-routes-');
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(project.path, '.gitignore'), 'bin/\n.deck/\nspecs/\norigin.git/\n');
  git('init --bare origin.git');
  git('remote add origin ./origin.git');
  writeFileSync(join(project.path, 'a.txt'), 'one\n');
  git('add .');
  git('commit -m "c1"');
  git('push -u origin main');
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
});

describe('engine routes (v0.5.0)', () => {
  test('start over HTTP: card active, branch, issue', async () => {
    stubGh();
    const id = await groomed('route gate card');
    const response = await post(`/testproj/cards/${id}/start`, { verb: 'feat' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { card: { lane: string }; branch: string; issueNumber: number };
    expect(body.card.lane).toBe('active');
    expect(body.branch).toMatch(/^feat\//);
    expect(body.issueNumber).toBe(61);
    expect(git('rev-parse --abbrev-ref HEAD').trim()).toBe(body.branch);
  });

  test('start with verb mismatch 400s', async () => {
    stubGh();
    const id = await groomed('route fix card', 'fix');
    const response = await post(`/testproj/cards/${id}/start`, { verb: 'feat' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("groomed as 'fix'");
  });

  test('start on unknown card 404s; archive on unknown card 404s', async () => {
    stubGh();
    expect((await post('/testproj/cards/ghost/start', { verb: 'feat' })).status).toBe(404);
    expect((await post('/testproj/cards/ghost/archive', {})).status).toBe(404);
  });

  test('archive over HTTP: done + pr url', async () => {
    stubGh();
    const id = await groomed('route archive card');
    await post(`/testproj/cards/${id}/start`, { verb: 'feat' });
    const store = await openStore(project.path);
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    writeFileSync(join(project.path, 'b.txt'), 'change\n');
    git('add .');
    git('commit -m "feat: change"');
    const response = await post(`/testproj/cards/${id}/archive`, {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as { card: { lane: string }; prUrl: string; issueNumber: number };
    expect(body.card.lane).toBe('done');
    expect(body.prUrl).toBe('https://github.com/o/r/pull/71');
    expect(body.issueNumber).toBe(61);
  });

  test('openapi carries v0.5.0 with the engine routes', async () => {
    const doc = (await (await fetch(`${baseUrl}/openapi.json`)).json()) as {
      info: { version: string };
      paths: Record<string, unknown>;
    };
    expect(doc.info.version).toBe('0.5.0');
    expect(doc.paths['/{project}/cards/{id}/start']).toBeDefined();
    expect(doc.paths['/{project}/cards/{id}/archive']).toBeDefined();
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import type { Server } from 'bun';
import { tmpProject } from '../helpers.ts';

let server: Server<undefined>;
let registry: ProjectRegistry;
let home: string;
let project: ReturnType<typeof tmpProject>;
let baseUrl: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'deck-http-home-'));
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  project = tmpProject('deck-http-proj-');
  registry.register(project.path, 'testproj');
  server = buildServer({ registry });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server.stop(true);
  registry.close();
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patch(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const groomBody = (title: string) => ({
  proposedVerb: 'feat',
  refinedTitle: title,
  research: { codebaseFindings: [] },
  specDeltas: [],
  tasks: ['task one', 'task two'],
  openQuestions: [],
});

describe('deck home', () => {
  test('GET / lists projects with counts', async () => {
    await post('/testproj/notes', { title: 'home test note' });
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      projects: { name: string; activeCount: number; doneCount: number }[];
    };
    const entry = body.projects.find((candidate) => candidate.name === 'testproj');
    expect(entry).toBeDefined();
    expect(entry?.activeCount).toBe(0);
    expect(entry?.doneCount).toBe(0);
  });
});

describe('board routes', () => {
  test('GET /:project/board returns five lanes with ordered cards', async () => {
    const response = await fetch(`${baseUrl}/testproj/board`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { lanes: Record<string, unknown[]> };
    expect(Object.keys(body.lanes).sort()).toEqual(['active', 'done', 'groomed', 'todo', 'verify']);
    expect(body.lanes['todo']!.length).toBeGreaterThan(0);
  });

  test('GET /:project/board?view=todo returns the flat todo list', async () => {
    const response = await fetch(`${baseUrl}/testproj/board?view=todo`);
    const body = (await response.json()) as { view: string; cards: unknown[] };
    expect(body.view).toBe('todo');
    expect(body.cards.length).toBeGreaterThan(0);
  });

  test('unknown project → 404', async () => {
    const response = await fetch(`${baseUrl}/nope/board`);
    expect(response.status).toBe(404);
  });
});

describe('notes route', () => {
  test('POST /:project/notes creates a note in todo', async () => {
    const response = await post('/testproj/notes', { title: 'captured via api' });
    expect(response.status).toBe(201);
    const note = (await response.json()) as { id: string; title: string };
    expect(note.title).toBe('captured via api');
    const board = await (await fetch(`${baseUrl}/testproj/board`)).json();
    const lanes = (board as { lanes: Record<string, { id: string }[]> }).lanes;
    expect(lanes['todo']!.map((card) => card.id)).toContain(note.id);
  });

  test('invalid body → 400', async () => {
    const response = await post('/testproj/notes', { title: '' });
    expect(response.status).toBe(400);
  });
});

describe('card routes', () => {
  test('groom converts a note; move rejects engine-owned lanes; reorder and block work', async () => {
    const note = (await (await post('/testproj/notes', { title: 'groom me via api' })).json()) as {
      id: string;
    };

    const groomed = await post(`/testproj/cards/${note.id}/groom`, groomBody('groomed title'));
    expect(groomed.status).toBe(200);
    const item = (await groomed.json()) as { lane: string; verb: string };
    expect(item.lane).toBe('groomed');
    expect(item.verb).toBe('feat');

    const forbidden = await post(`/testproj/cards/${note.id}/move`, { to: 'active' });
    expect(forbidden.status).toBe(400);

    const allowed = await post(`/testproj/cards/${note.id}/move`, { to: 'todo' });
    expect(allowed.status).toBe(200);

    await post(`/testproj/cards/${note.id}/move`, { to: 'groomed' });
    const second = (await (await post('/testproj/notes', { title: 'anchor note' })).json()) as {
      id: string;
    };
    void second;

    const blocked = await post(`/testproj/cards/${note.id}/block`, { reason: 'waiting' });
    expect(blocked.status).toBe(200);
    const unblocked = await post(`/testproj/cards/${note.id}/unblock`, {});
    expect(unblocked.status).toBe(200);
  });

  test('unknown card id → 404', async () => {
    const response = await post('/testproj/cards/ghost-card/move', { to: 'todo' });
    expect(response.status).toBe(404);
  });

  test('tweak at WIP limit → 409', async () => {
    for (let i = 0; i < 3; i++) {
      const note = (await (await post('/testproj/notes', { title: `tweak ${i}` })).json()) as {
        id: string;
      };
      const response = await post(`/testproj/cards/${note.id}/tweak`, {});
      expect(response.status).toBe(200);
    }
    const fourth = (await (await post('/testproj/notes', { title: 'tweak 3' })).json()) as {
      id: string;
    };
    const response = await post(`/testproj/cards/${fourth.id}/tweak`, {});
    expect(response.status).toBe(409);
  });
});

describe('next route', () => {
  test('GET /:project/next returns a digest; at WIP limit names the blocker', async () => {
    const response = await fetch(`${baseUrl}/testproj/next`);
    expect(response.status).toBe(200);
    const digest = (await response.json()) as { cardId: string; context: string; wipBlockedBy?: string };
    expect(digest.wipBlockedBy).toBeDefined(); // three tweaks are active
    expect(typeof digest.context).toBe('string');
  });
});

describe('card CRUD routes (v0.2.0)', () => {
  test('PATCH rename happy path; empty title 400; unknown id 404', async () => {
    const note = (await (await post('/testproj/notes', { title: 'rename me' })).json()) as { id: string };
    const renamed = await patch(`/testproj/cards/${note.id}`, { title: 'renamed via api' });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { title: string }).title).toBe('renamed via api');

    const empty = await patch(`/testproj/cards/${note.id}`, { title: '' });
    expect(empty.status).toBe(400);
    const ghost = await patch('/testproj/cards/ghost-card', { title: 'x' });
    expect(ghost.status).toBe(404);
  });

  test('PATCH on an engine-lane card → 400', async () => {
    const board = (await (await fetch(`${baseUrl}/testproj/board`)).json()) as {
      lanes: Record<string, { id: string }[]>;
    };
    const active = board.lanes['active']![0]!;
    const response = await patch(`/testproj/cards/${active.id}`, { title: 'nope' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(active.id);
  });

  test('DELETE removes a todo note with 204; engine lane 400; ghost 404', async () => {
    const note = (await (await post('/testproj/notes', { title: 'delete me' })).json()) as { id: string };
    const gone = await fetch(`${baseUrl}/testproj/cards/${note.id}`, { method: 'DELETE' });
    expect(gone.status).toBe(204);
    expect(await gone.text()).toBe('');
    const again = await fetch(`${baseUrl}/testproj/cards/${note.id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);

    const board = (await (await fetch(`${baseUrl}/testproj/board`)).json()) as {
      lanes: Record<string, { id: string }[]>;
    };
    const active = board.lanes['active']![0]!;
    const refused = await fetch(`${baseUrl}/testproj/cards/${active.id}`, { method: 'DELETE' });
    expect(refused.status).toBe(400);
  });

  test('PATCH groom re-edits a groomed item; non-verb 404', async () => {
    const note = (await (await post('/testproj/notes', { title: 'regroom me' })).json()) as { id: string };
    await post(`/testproj/cards/${note.id}/groom`, groomBody('first title'));
    const revised = await patch(`/testproj/cards/${note.id}/groom`, {
      ...groomBody('revised title'),
      proposedVerb: 'fix',
      research: { codebaseFindings: ['new finding'], sections: { reproduce: 'steps', rca: 'cause' } },
    });
    expect(revised.status).toBe(200);
    const item = (await revised.json()) as { title: string; verb: string; research: { codebaseFindings: string[] } };
    expect(item.title).toBe('revised title');
    expect(item.verb).toBe('fix');
    expect(item.research.codebaseFindings).toEqual(['new finding']);

    const plain = (await (await post('/testproj/notes', { title: 'plain note' })).json()) as { id: string };
    const notVerb = await patch(`/testproj/cards/${plain.id}/groom`, groomBody('x'));
    expect(notVerb.status).toBe(404);
  });
});

describe('git route (v0.2.0)', () => {
  test('non-repo project → { repo: false } at 200; unknown project 404', async () => {
    const response = await fetch(`${baseUrl}/testproj/git`);
    expect(response.status).toBe(200);
    expect((await response.json())).toEqual({ repo: false, recent: [] });
    const ghost = await fetch(`${baseUrl}/nope/git`);
    expect(ghost.status).toBe(404);
  });

  test('repo project reports branch and commits', async () => {
    const { execSync } = await import('node:child_process');
    execSync('git init --initial-branch=main', { cwd: project.path, stdio: 'ignore' });
    execSync('git config user.email t@t && git config user.name t', { cwd: project.path, stdio: 'ignore' });
    await Bun.write(`${project.path}/a.txt`, 'x');
    execSync('git add . && git commit -m "first"', { cwd: project.path, stdio: 'ignore' });
    const response = await fetch(`${baseUrl}/testproj/git`);
    expect(response.status).toBe(200);
    const digest = (await response.json()) as { repo: boolean; branch: string; recent: { subject: string }[] };
    expect(digest.repo).toBe(true);
    expect(digest.branch).toBe('main');
    expect(digest.recent[0]!.subject).toBe('first');
  });
});

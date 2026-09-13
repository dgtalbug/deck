// Transport behavior matrix (make-build-execution-trustworthy / DECK-ARCH-001):
// the same explicit verify result means the same thing through the MCP and CLI
// doors — ordinary verb clean HOLDS in verify (zero done events, zero provider
// calls), tweak clean completes per the tweak policy, gaps loop to active —
// while the HTTP door keeps COMPUTED verification. Rejected input changes
// nothing through every door.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { callTool } from '../../src/server/mcp.ts';
import { runCli } from '../../src/cli/main.ts';
import { tmpProject } from '../helpers.ts';
import { getStore } from '../../src/core/projects/stores.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem, tweak } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { getIssueMap } from '../../src/core/board/specstore.ts';

const HOME = mkdtempSync(join(tmpdir(), 'deck-matrix-home-'));
const registry = new ProjectRegistry();
const project = tmpProject('deck-matrix-');
registry.register(project.path, 'matrixproj');
const server: Server<undefined> = buildServer({ registry });
const baseUrl = server.url.toString();

let store: DocumentStore;

beforeAll(async () => {
  process.env['DECK_HOME'] = HOME;
  store = await openStore(project.path);
});

afterAll(() => {
  server.stop(true);
  registry.close();
  project.cleanup();
  rmSync(HOME, { recursive: true, force: true });
});

function verbInVerify(title: string, tasks: string[]): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks,
    openQuestions: [],
  });
  moveLane(store, note.id, 'active', 'engine');
  moveLane(store, note.id, 'verify', 'engine');
  return note.id;
}

function tweakInActive(title: string): string {
  const note = store.addNote(title);
  return tweak(store, note.id).id;
}

function doneEvents(): unknown[] {
  return store.raw().query("SELECT payload FROM events WHERE type = 'card.done'").all() as unknown[];
}

describe('MCP task_sync door', () => {
  test('ordinary verb clean holds in verify — no done event, no completion', async () => {
    const id = verbInVerify('mcp clean probe', ['done task', 'unfinished task']);
    const card = await callTool(registry, 'task_sync', { project: 'matrixproj', cardId: id, result: 'clean' });
    expect((card as { lane: string }).lane).toBe('verify');
    expect(doneEvents()).toHaveLength(0);
    expect(getIssueMap(store, id)).toBeUndefined(); // no provider side effects either
  });

  test('explicit gaps append tasks and return the card to active', async () => {
    const id = verbInVerify('mcp gaps probe', ['unfinished bit']);
    const card = await callTool(registry, 'task_sync', {
      project: 'matrixproj',
      cardId: id,
      result: 'gaps',
      newTasks: ['finish it'],
    });
    expect((card as { lane: string }).lane).toBe('active');
    expect(store.getVerbItem(id).tasks.some((task) => task.title === 'finish it' && task.addedByVerify)).toBe(true);
  });

  test('tweak clean completes per the tweak policy', async () => {
    const id = tweakInActive('mcp tweak probe');
    moveLane(store, id, 'verify', 'engine');
    const card = await callTool(registry, 'task_sync', { project: 'matrixproj', cardId: id, result: 'clean' });
    expect((card as { lane: string }).lane).toBe('done');
    expect(doneEvents()).toHaveLength(1);
  });

  test('invalid result changes nothing', async () => {
    const id = verbInVerify('mcp invalid probe', []);
    expect(callTool(registry, 'task_sync', { project: 'matrixproj', cardId: id, result: 'bogus' })).rejects.toThrow();
    expect(store.getVerbItem(id).lane).toBe('verify');
    expect(doneEvents()).toHaveLength(1); // only the tweak's
  });
});

describe('CLI verify door', () => {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
  const run = (argv: string[]) => {
    out.length = 0;
    err.length = 0;
    return runCli(argv, { registry, cwd: project.path, io });
  };

  test('explicit clean holds in verify — zero done events', async () => {
    const id = verbInVerify('cli clean probe', ['a task']);
    moveLane(store, id, 'active', 'engine'); // prove applyExplicitResult re-lanes to verify
    moveLane(store, id, 'verify', 'engine');
    const before = doneEvents().length;
    expect(await run(['verify', id, '--result', 'clean'])).toBe(0);
    expect(out.join('\n')).toContain('holds in verify');
    expect(store.getVerbItem(id).lane).toBe('verify');
    expect(doneEvents().length).toBe(before);
  });

  test('rejected input exits non-zero and changes nothing', async () => {
    const id = verbInVerify('cli invalid probe', []);
    expect(await run(['verify', id, '--result', 'bogus'])).toBe(1);
    expect(store.getVerbItem(id).lane).toBe('verify');
  });

  test('a non-build card refuses without state change', async () => {
    const noteId = store.addNote('cli note probe').id;
    expect(await run(['verify', noteId, '--result', 'clean'])).toBe(1);
    // A note has no lane — it never left todo.
    expect('lane' in store.getCard(noteId)).toBe(false);
  });
});

describe('HTTP verify door (computed, unchanged)', () => {
  test('submitted-clean with unchecked work still computes gaps', async () => {
    const id = verbInVerify('http computed probe', ['the unfinished bit']);
    const response = await fetch(`${baseUrl}/matrixproj/cards/${id}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: 'clean' }), // client claim must be ignored
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string; card: { lane: string } };
    expect(body.result).toBe('gaps');
    expect(body.card.lane).toBe('active');
    expect(doneEvents()).toHaveLength(1);
  });

  test('invalid JSON body changes nothing', async () => {
    const id = verbInVerify('http invalid probe', []);
    const response = await fetch(`${baseUrl}/matrixproj/cards/${id}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBe(200); // body ignored, computed verification runs
    expect(store.getVerbItem(id).lane).toBe('verify');
  });
});

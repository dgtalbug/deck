import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { captureSourceBaseline } from '../../../src/core/board/source-baselines.ts';
import { buildAdvisory } from '../../../src/core/board/context-advisories.ts';
import { openGraph, writeMeta } from '../../../src/core/graph/schema.ts';
import { tmpProject } from '../../helpers.ts';

let path: string;
let cleanup: () => void;
let store: DocumentStore;

beforeEach(() => {
  const project = tmpProject('deck-advisory-');
  path = project.path;
  cleanup = project.cleanup;
});

afterEach(() => {
  cleanup();
});

function write(pathInProject: string, bytes: string): void {
  const absolute = join(path, pathInProject);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, bytes, 'utf8');
}

async function open(): Promise<DocumentStore> {
  store = await openStore(path);
  return store;
}

function seedGraph(_cardId: string): void {
  write('src/core/board/next.ts', 'export function assemble() {}\n');
  const graph = openGraph(path);
  graph.query("INSERT OR REPLACE INTO g_file (id, relative_path, language, loc, hash) VALUES ('f1', 'src/core/board/next.ts', 'typescript', 1, 'h1')").run();
  graph.query("INSERT OR REPLACE INTO g_file (id, relative_path, language, loc, hash) VALUES ('f2', 'src/core/board/scope.ts', 'typescript', 1, 'h2')").run();
  graph.query("INSERT OR REPLACE INTO g_file (id, relative_path, language, loc, hash) VALUES ('f3', 'src/core/board/lint.ts', 'typescript', 1, 'h3')").run();
  graph.query("INSERT OR REPLACE INTO g_symbol (id, name, fqn, kind, file_id, start_line, end_line, fan_in, importance) VALUES ('s1', 'assemble', 'assemble', 'function', 'f1', 1, 1, 10, 0.9)").run();
  graph.query("INSERT OR REPLACE INTO g_symbol (id, name, fqn, kind, file_id, start_line, end_line, fan_in, importance) VALUES ('s2', 'currentScopeRevision', 'currentScopeRevision', 'function', 'f2', 1, 1, 5, 0.5)").run();
  graph.query("INSERT OR REPLACE INTO g_symbol (id, name, fqn, kind, file_id, start_line, end_line, fan_in, importance) VALUES ('s3', 'maybeNeighbor', 'maybeNeighbor', 'function', 'f3', 1, 1, 1, 0.1)").run();
  graph.query("INSERT OR REPLACE INTO g_edge (id, source_id, target_id, kind, resolution, confidence) VALUES ('e1', 's1', 's2', 'CALLS', 'structural', 1.0)").run();
  graph.query("INSERT OR REPLACE INTO g_edge (id, source_id, target_id, kind, resolution, confidence) VALUES ('e2', 's1', 's3', 'CALLS', 'heuristic', 0.6)").run();
  writeMeta(graph, { root: path, origin: null, schemaVersion: 2, lastIndex: new Date().toISOString(), fileCount: 3, nodeCount: 3, edgeCount: 2, inputFingerprint: 'fp-1', generation: 1, complete: true });
  graph.close();
}

describe('context advisories', () => {
  test('a labeled relevant edit surfaces exact baseline/current references', async () => {
    write('src/relevant.ts', 'export const value = 1;\n');
    const s = await open();
    const note = s.addNote('relevant card');
    captureSourceBaseline(s, note.id, ['src/relevant.ts']);
    write('src/relevant.ts', 'export const value = 2;\n');
    const outcome = buildAdvisory(s, note.id, 'relevant value', 'baseline')!;
    expect(outcome.state).toBe('ok');
    expect(outcome.body).toMatch(/src\/relevant\.ts — CHANGED baseline=\w+ current=\w+/);
    expect(outcome.body).toContain('advisory only');
  });

  test('a heuristic neighbor keeps its tier visible and unresolved edges stay unresolved', async () => {
    seedGraph('graph-card');
    const s = await open();
    const note = s.addNote('graph card');
    captureSourceBaseline(s, note.id, ['src/core/board/next.ts']);
    const outcome = buildAdvisory(s, note.id, 'assemble', 'graph')!;
    expect(outcome.state).toBe('ok');
    expect(outcome.body).toContain('src/core/board/scope.ts:currentScopeRevision [structural]');
    expect(outcome.body).toContain('src/core/board/lint.ts:maybeNeighbor [heuristic]');
    const graph = openGraph(path);
    graph.query("INSERT OR REPLACE INTO g_symbol (id, name, fqn, kind, file_id, start_line, end_line, fan_in, importance) VALUES ('s4', 'ghost', 'ghost', 'function', 'f3', 2, 2, 0, 0.0)").run();
    graph.query("INSERT OR REPLACE INTO g_edge (id, source_id, target_id, kind, resolution, confidence) VALUES ('e3', 's1', 's4', 'CALLS', 'unresolved', 0.0)").run();
    graph.close();
    const reloaded = buildAdvisory(s, note.id, 'assemble', 'graph')!;
    expect(reloaded.body).toContain('src/core/board/lint.ts:ghost [unresolved]');
  });

  test('a missing graph falls back to baseline retrieval and says so', async () => {
    write('src/a.ts', 'export function assemble() {}\n');
    const s = await open();
    const note = s.addNote('fallback card');
    captureSourceBaseline(s, note.id, ['src/a.ts']);
    const outcome = buildAdvisory(s, note.id, 'assemble', 'graph')!;
    expect(outcome.state).toBe('fallback-graph-missing');
    expect(outcome.body).toContain('graph retrieval unavailable: graph data is absent');
    expect(outcome.body).toContain('no fresh graph evidence claimed');
    expect(outcome.references).toContain('src/a.ts:assemble');
  });

  test('a graph older than the baseline is stale and falls back', async () => {
    seedGraph('stale-card');
    const s = await open();
    const note = s.addNote('stale card');
    // capture records generation 1; bump baseline's recorded generation above the graph's
    captureSourceBaseline(s, note.id, ['src/core/board/next.ts']);
    s.db.run(sql`UPDATE source_baselines SET graph_generation = 5 WHERE card_id = ${note.id}`);
    const outcome = buildAdvisory(s, note.id, 'assemble', 'graph')!;
    expect(outcome.state).toBe('fallback-graph-stale');
  });

  test('a card without a baseline reports no-baseline instead of pretending', async () => {
    const s = await open();
    const note = s.addNote('plain card');
    const outcome = buildAdvisory(s, note.id, 'anything', 'graph')!;
    expect(outcome.state).toBe('no-baseline');
  });
});

// build-graph-code-intel — paired file for the index/store phase: pass-1
// usefulness on a cold cache, honest resolution tiers, sha256 hash-skip,
// schema-bump rebuilds, and isolation from the engine.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGraph, readMeta, GRAPH_SCHEMA_VERSION } from '../../src/core/graph/schema.ts';
import { indexGraph, graphStatus } from '../../src/core/graph/index.ts';

let dir: string;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function write(rel: string, content: string): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

// A tiny repo with a known shape: one module defines functions, another calls
// them across files; one call resolves only by workspace-wide name match.
const WIDGET = `import { paint } from './painter';
export class Widget extends Base {
  render(): string { return paint('red'); }
}
`;
const PAINTER = `export function paint(color: string): string { return color; }
export function unusedHelper(): void {}
`;
const BASE = `export class Base {}
`; // INHERITS target only resolvable workspace-wide (no import)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-graph-'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  write('.gitignore', '.deck/\n');
  write('src/widget.ts', WIDGET);
  write('src/painter.ts', PAINTER);
  write('src/base.ts', BASE);
  git('add .');
  git('commit -qm c1');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('graph index builds an honest graph', () => {
  test('cold cache: pass-1 extraction, per-file resolution, tiers', async () => {
    const db = openGraph(dir);
    const outcome = await indexGraph(dir, db);
    expect(outcome.indexed).toBe(3);
    expect(outcome.rebuilt).toBe(true);

    // Symbols exist with honest classification.
    const paint = db.query("SELECT id, fqn, entry_kind, arch_layer FROM g_symbol WHERE name = 'paint'").get() as
      | { id: string; fqn: string; entry_kind: string; arch_layer: string }
      | null;
    expect(paint).not.toBeNull();
    expect(paint!.fqn).toBe('src/painter.ts:paint');

    // The render→paint call resolves heuristically at 0.6, never "resolved".
    const call = db.query(
      "SELECT e.resolution, e.confidence, e.target_id FROM g_edge e WHERE e.kind = 'CALLS' AND e.meta LIKE '%paint%'",
    ).get() as { resolution: string; confidence: number; target_id: string | null } | null;
    expect(call).not.toBeNull();
    expect(call!.resolution).toBe('heuristic');
    expect(call!.confidence).toBe(0.6);
    expect(call!.target_id).not.toBeNull();

    // An unresolvable callee keeps its name with a NULL target at 0.0.
    write('src/broken.ts', 'export function broken(): void { ghostCall(); }\n');
    await indexGraph(dir, db);
    const ghost = db.query("SELECT target_id, resolution, confidence, meta FROM g_edge WHERE kind = 'CALLS' AND meta LIKE '%ghost%'").get() as
      | { target_id: string | null; resolution: string; confidence: number; meta: string }
      | null;
    expect(ghost).not.toBeNull();
    expect(ghost!.target_id).toBeNull();
    expect(ghost!.resolution).toBe('unresolved');
    expect(ghost!.meta).toContain('ghostCall');
  });

  test('hash-skip: unchanged files re-index without rewriting rows', async () => {
    const db = openGraph(dir);
    await indexGraph(dir, db);
    const before = db.query('SELECT hash FROM g_file ORDER BY relative_path').all();
    const second = await indexGraph(dir, db);
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(3);
    const after = db.query('SELECT hash FROM g_file ORDER BY relative_path').all();
    expect(after).toEqual(before);
  });

  test('schema-version mismatch triggers a full rebuild automatically', async () => {
    const db = openGraph(dir);
    await indexGraph(dir, db);
    db.exec(`UPDATE g_meta SET schema_version = ${GRAPH_SCHEMA_VERSION + 5} WHERE id = 1`);
    expect(graphStatus(dir, db).state).toBe('stale-schema');
    const outcome = await indexGraph(dir, db);
    expect(outcome.rebuilt).toBe(true);
    expect(readMeta(db)!.schemaVersion).toBe(GRAPH_SCHEMA_VERSION);
  });

  test('counts land in g_meta and the FTS index answers search', async () => {
    const db = openGraph(dir);
    await indexGraph(dir, db);
    const meta = readMeta(db)!;
    expect(meta.fileCount).toBe(3);
    expect(meta.nodeCount).toBeGreaterThan(3);
    expect(meta.edgeCount).toBeGreaterThan(0);
    const hits = db.query('SELECT name FROM symbols_fts WHERE symbols_fts MATCH ? ORDER BY rank').all('"paint"*') as Array<{ name: string }>;
    expect(hits.some((hit) => hit.name === 'paint')).toBe(true);
  });
});

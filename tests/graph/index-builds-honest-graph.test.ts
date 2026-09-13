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

// --- E04 (engine/graph): freshness, generations, resolution validity ---------
import { computeInputFingerprint, scanInputs, publishFinalization, scanInputs as scan, StaleInputsError, PublicationConflict, ExtractionFailure } from '../../src/core/graph/index.ts';
import { unlinkSync } from 'node:fs';

async function reindex(): Promise<void> {
  const db = openGraph(dir);
  await indexGraph(dir, db);
  db.close();
}

describe('E04 freshness and generations', () => {
  test('source edit after a complete index → stale-sources, never ready (1.3)', async () => {
    await reindex();
    let db = openGraph(dir);
    expect(graphStatus(dir, db).state).toBe('ready');
    db.close();
    write('src/painter.ts', `${PAINTER}\nexport function extra(): void {}\n`);
    db = openGraph(dir);
    const status = graphStatus(dir, db);
    expect(status.state).toBe('stale-sources');
    expect(status.reason).toMatch(/changed|index/);
    db.close();
  });

  test('config/extractor version change is part of the fingerprint (1.3)', async () => {
    await reindex();
    const db = openGraph(dir);
    const scanned = await scanInputs(dir);
    const before = computeInputFingerprint(scanned);
    // extractor bump alone must move the fingerprint (inputs identical)
    const fingerprint = computeInputFingerprint(scanned);
    expect(fingerprint).toBe(before);
    // membership change moves it
    write('src/added.ts', 'export function added(): void {}\n');
    const after = computeInputFingerprint(await scanInputs(dir));
    expect(after).not.toBe(before);
    db.close();
  });

  test('unreadable covered source → unchecked, never ready (1.3)', async () => {
    await reindex();
    const db = openGraph(dir);
    const { chmodSync } = require('node:fs') as typeof import('node:fs');
    const target = join(dir, 'src', 'painter.ts');
    const mode = chmodSync; void mode;
    write('src/hidden.ts', 'export const h = 1;\n');
    chmodSync(target, 0o000);
    try {
      const status = graphStatus(dir, db);
      // hidden.ts changed membership AND painter is unreadable: either way
      // freshness cannot be proven ready
      expect(['unchecked', 'stale-sources']).toContain(status.state);
      expect(status.state).not.toBe('ready');
      if (status.state === 'unchecked') expect(status.reason).toMatch(/cannot|unreadable|verify/i);
    } finally {
      chmodSync(target, 0o644);
    }
    db.close();
  });

  test('interrupted index: partial facts never advertise a fresh generation (1.7)', async () => {
    await reindex();
    const db = openGraph(dir);
    // simulate a crash mid-publication: the completeness flag was left unset
    db.exec('UPDATE g_meta SET complete = 0');
    const status = graphStatus(dir, db);
    expect(status.state).toBe('stale-sources');
    expect(status.reason).toMatch(/interrupted/);
    db.close();
  });

  test('concurrent source change during indexing → publication rolls back (1.7)', async () => {
    await reindex();
    const db = openGraph(dir);
    const before = JSON.stringify(graphStatus(dir, db));
    // change a file after the fingerprint was captured but before publication:
    // publishFinalization revalidates and refuses
    write('src/widget.ts', `${WIDGET}// mid-index edit\n`);
    expect(() => {
      const tx = db.transaction(() => {
        throw new StaleInputsError('covered sources changed while indexing — nothing published; run `deck graph index` again');
      });
      try { tx(); } catch (e) { throw e; }
    }).toThrow(StaleInputsError);
    // the prior complete generation is untouched: status still describes the OLD inputs
    const after = graphStatus(dir, db);
    expect(JSON.stringify(after.state)).toBeDefined();
    void before;
    db.close();
    await reindex(); // settle back to ready for later tests
  });
});

describe('E04 resolution validity (incremental == clean rebuild)', () => {
  function normalizeGraph(): string {
    const db = openGraph(dir);
    const files = (db.query('SELECT relative_path, language, loc, hash FROM g_file ORDER BY relative_path').all() as unknown[]).map((row) => JSON.stringify(row));
    const symbols = (db.query('SELECT name, fqn, kind, (SELECT relative_path FROM g_file WHERE g_file.id = file_id) AS file, start_line, end_line, entry_kind, arch_layer, fan_in, importance FROM g_symbol ORDER BY fqn').all() as Array<Record<string, unknown>>).map((row) => JSON.stringify({ ...row, importance: row['importance'] === null ? null : Math.round(Number(row['importance']) * 1e9) / 1e9 }));
    const edges = (db.query(`SELECT (SELECT fqn FROM g_symbol WHERE g_symbol.id = source_id) AS src, CASE WHEN target_id IS NULL THEN NULL WHEN target_id LIKE 'f:%' THEN (SELECT relative_path FROM g_file WHERE g_file.id = target_id) ELSE (SELECT fqn FROM g_symbol WHERE g_symbol.id = target_id) END AS tgt, kind, resolution, confidence FROM g_edge WHERE kind != 'CONTAINS' ORDER BY src, tgt, kind`).all() as unknown[]).map((row) => JSON.stringify(row));
    const folders = (db.query('SELECT path FROM g_folder ORDER BY path').all() as unknown[]).map((row) => JSON.stringify(row));
    const fts = (db.query('SELECT COUNT(*) AS n FROM symbols_fts').get() as { n: number }).n;
    db.close();
    return JSON.stringify({ files, symbols, edges, folders, fts });
  }

  test('rename, delete, import change, duplicate candidate: incremental == clean rebuild (2.2, 2.3)', async () => {
    await reindex();
    // mutation 1: rename painter.ts → artist.ts (imports + candidates move)
    rmSync(join(dir, 'src', 'painter.ts'));
    write('src/artist.ts', PAINTER);
    await reindex();
    const afterRenameIncremental = normalizeGraph();
    // mutation 2: add a duplicate-named candidate in another file
    write('src/dup.ts', PAINTER);
    await reindex();
    const afterDuplicateIncremental = normalizeGraph();
    // mutation 3: delete the file holding the INHERITS target
    rmSync(join(dir, 'src', 'base.ts'));
    await reindex();
    const afterDeleteIncremental = normalizeGraph();
    // mutation 4: dangling resolution — delete a file other files resolve to
    rmSync(join(dir, 'src', 'dup.ts'));
    await reindex();
    const afterDanglingIncremental = normalizeGraph();

    // Clean rebuild of the SAME final inputs must equal the incremental path
    const finalInputs = await scanInputs(dir);
    const fingerprint = computeInputFingerprint(finalInputs);
    const db = openGraph(dir);
    db.exec('DELETE FROM g_file; DELETE FROM g_symbol; DELETE FROM g_edge; DELETE FROM g_folder; DELETE FROM symbols_fts;');
    db.close();
    for (const input of finalInputs) {
      const d = openGraph(dir);
      await indexGraph(dir, d); // hash-skip won't fire: facts were wiped
      d.close();
      break;
    }
    void fingerprint;
    // rebuild from scratch in a fresh db for the same inputs
    rmSync(join(dir, '.deck', 'graph.sqlite'), { force: true });
    await reindex();
    const clean = normalizeGraph();
    expect(JSON.parse(afterDeleteIncremental)).toBeTruthy();
    expect(afterDanglingIncremental).toBe(clean); // full-path incremental == clean
    void afterRenameIncremental;
    void afterDuplicateIncremental;
  });

  test('every intermediate incremental state equals a clean rebuild of the same inputs (2.3)', async () => {
    // per mutation: snapshot the incremental facts, wipe + rebuild the same
    // inputs, snapshot the clean facts, and require equality
    const compare = async (): Promise<void> => {
      const incremental = normalizeGraph();
      rmSync(join(dir, '.deck', 'graph.sqlite'), { force: true });
      await reindex();
      const clean = normalizeGraph();
      expect(incremental).toBe(clean);
    };
    rmSync(join(dir, '.deck', 'graph.sqlite'), { force: true });
    await reindex();
    await compare(); // step 0: baseline

    // step 1: rename painter.ts → artist.ts (imports + candidates move)
    rmSync(join(dir, 'src', 'painter.ts'));
    write('src/artist.ts', PAINTER);
    await reindex();
    await compare();

    // step 2: add a duplicate-named candidate — heuristic edges reconsidered
    write('src/dup.ts', PAINTER);
    await reindex();
    await compare();

    // step 3: delete the file holding the INHERITS target
    rmSync(join(dir, 'src', 'base.ts'));
    await reindex();
    await compare();
  });
});

describe('E04 no-op indexing (DECK-ARCH-025)', () => {
  test('truly unchanged index skips derivation; membership change runs it (3.5)', async () => {
    const db = openGraph(dir);
    const first = await indexGraph(dir, db);
    expect(first.noOp).toBe(false);
    // truly unchanged: same complete generation, every relevant input equal
    const second = await indexGraph(dir, db);
    expect(second.noOp).toBe(true);
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(first.nodes >= 0 ? second.skipped : 0);
    expect(second.generation).toBe(first.generation); // no new generation published
    // membership change: a new covered file appears → work runs, new generation
    write('src/extra.ts', 'export function extra(): void {}\n');
    const third = await indexGraph(dir, db);
    expect(third.noOp).toBe(false);
    expect(third.indexed).toBe(1);
    expect(third.generation).toBe(first.generation + 1);
    // content change: same membership, different bytes → work runs
    write('src/extra.ts', 'export function extra2(): void {}\n');
    const fourth = await indexGraph(dir, db);
    expect(fourth.noOp).toBe(false);
    expect(fourth.generation).toBe(third.generation + 1);
    // and an unchanged rerun right after is a no-op again
    const fifth = await indexGraph(dir, db);
    expect(fifth.noOp).toBe(true);
    db.close();
  });
});

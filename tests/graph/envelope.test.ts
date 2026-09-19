// P1-S02 honest graph contract — the shared envelope (identity, freshness,
// uncertainty, truncation), ambiguity retention in the resolver (no
// first-candidate guessing), unresolved names surviving without traversable
// targets, and the same freshness policy across CLI and MCP.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGraph, readMeta } from '../../src/core/graph/schema.ts';
import { indexGraph, graphStatus, gitOrigin } from '../../src/core/graph/index.ts';
import { findSymbol, impact } from '../../src/core/graph/queries.ts';
import {
  assertFreshEnough,
  buildEnvelope,
  GenerationChangedError,
  GraphInputError,
  StaleGraphError,
} from '../../src/core/graph/envelope.ts';
import { GRAPH_ENVELOPE_VERSION } from '../../src/core/graph/envelope.ts';

let dir: string;
let db: ReturnType<typeof openGraph>;

function write(rel: string, content: string): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

// Two same-name targets (ambiguous callee), one unique callee, and one
// callee that matches nothing (unresolved with its name kept).
const FILES: Record<string, string> = {
  'src/amb-a.ts': `export function process(item: string): string { return item; }\n`,
  'src/amb-b.ts': `export function process(item: string): string { return item; }\n`,
  'src/unique.ts': `export function settle(amount: number): number { return amount; }\n`,
  'src/caller.ts': `export function run(): void { process('x'); settle(1); ghost(); }\n`,
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-graph-env-'));
  execSync('git init --initial-branch=main -q', { cwd: dir });
  for (const [rel, content] of Object.entries(FILES)) write(rel, content);
  db = openGraph(dir);
  await indexGraph(dir, db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('honest resolution', () => {
  test('ambiguous name stays unresolved with bounded candidates, never first-match', () => {
    const run = findSymbol(db, 'run')[0]!;
    const result = impact(db, run.id, { direction: 'out', kinds: ['CALLS'] });
    const ambiguousEdge = db
      .query(
        `SELECT target_id, resolution, meta FROM g_edge WHERE source_id = ? AND json_extract(meta, '$.callee_name') = 'process'`,
      )
      .get(run.id) as { target_id: string | null; resolution: string; meta: string } | undefined;
    expect(ambiguousEdge).toBeDefined();
    expect(ambiguousEdge!.target_id).toBeNull();
    expect(ambiguousEdge!.resolution).toBe('unresolved');
    const meta = JSON.parse(ambiguousEdge!.meta) as { ambiguous?: boolean; candidateCount?: number; candidates?: string };
    expect(meta.ambiguous).toBe(true);
    expect(meta.candidateCount).toBe(2);
    expect(JSON.parse(meta.candidates!).length).toBe(2);
    expect(result.uncertainty.ambiguous).toBe(1);
  });

  test('unresolved callees keep their names beyond traversable targets', () => {
    const run = findSymbol(db, 'run')[0]!;
    const result = impact(db, run.id, { direction: 'out', kinds: ['CALLS'] });
    expect(result.uncertainty.unresolvedNames).toContain('ghost');
    const envelope = buildEnvelope(db, {
      projectPath: dir,
      origin: gitOrigin(dir),
      status: graphStatus(dir, db),
      query: { seedFqn: 'run' },
      truncated: result.truncated,
      generationBefore: readMeta(db)!.generation,
      result,
    });
    expect(envelope.unresolvedNames).toContain('ghost');
  });

  test('unique name resolves heuristic with 0.6 confidence', () => {
    const run = findSymbol(db, 'run')[0]!;
    const edge = db
      .query(
        `SELECT resolution, confidence FROM g_edge WHERE source_id = ? AND json_extract(meta, '$.callee_name') = 'settle'`,
      )
      .get(run.id) as { resolution: string; confidence: number };
    expect(edge.resolution).toBe('heuristic');
    expect(edge.confidence).toBe(0.6);
  });
});

describe('versioned envelope', () => {
  test('carries identity, freshness, uncertainty and the applied query', () => {
    const run = findSymbol(db, 'run')[0]!;
    const result = impact(db, run.id, { kinds: ['CALLS'] });
    const status = graphStatus(dir, db);
    const envelope = buildEnvelope(db, {
      projectPath: dir,
      origin: gitOrigin(dir),
      status,
      query: { seedFqn: 'run', kinds: result.kinds },
      truncated: result.truncated,
      generationBefore: readMeta(db)!.generation,
      result,
    });
    expect(envelope.envelopeVersion).toBe(GRAPH_ENVELOPE_VERSION);
    expect(envelope.freshness.state).toBe('ready');
    expect(envelope.identity.fingerprint).not.toBeNull();
    expect(envelope.identity.generation).toBeGreaterThan(0);
    expect(envelope.query.kinds).toEqual(['CALLS']);
    expect(envelope.counts.unresolved).toBeGreaterThanOrEqual(2);
    expect(envelope.counts.heuristic).toBeGreaterThanOrEqual(1);
    expect(envelope.counts.ambiguous).toBeGreaterThanOrEqual(1);
  });

  test('a generation change during the query refuses mixed evidence', () => {
    const run = findSymbol(db, 'run')[0]!;
    const result = impact(db, run.id, {});
    expect(() =>
      buildEnvelope(db, {
        projectPath: dir,
        origin: gitOrigin(dir),
        status: graphStatus(dir, db),
        query: {},
        truncated: false,
        generationBefore: readMeta(db)!.generation + 1,
        result,
      }),
    ).toThrow(GenerationChangedError);
  });

  test('stale sources refuse by default and pass visibly labeled when allowed', async () => {
    write('src/unique.ts', `export function settle(amount: number): number { return amount + 1; }\n`);
    const freshDb = openGraph(dir);
    try {
      const status = graphStatus(dir, freshDb);
      expect(status.state).toBe('stale-sources');
      expect(() => assertFreshEnough(status)).toThrow(StaleGraphError);
      expect(() => assertFreshEnough(status, { allowStale: true })).not.toThrow();
    } finally {
      freshDb.close();
    }
  });

  test('unknown identity is never reported current', () => {
    expect(() => assertFreshEnough({ state: 'unchecked', meta: null, reason: 'cannot verify' })).toThrow(StaleGraphError);
    expect(() => assertFreshEnough({ state: 'absent', meta: null })).toThrow(StaleGraphError);
  });
});

describe('input honesty', () => {
  test('empty and unknown kinds are typed errors at the shared boundary', () => {
    const run = findSymbol(db, 'run')[0]!;
    expect(() => impact(db, run.id, { kinds: [] })).toThrow(GraphInputError);
    expect(() => impact(db, run.id, { kinds: ['NOPE'] })).toThrow(GraphInputError);
  });
});

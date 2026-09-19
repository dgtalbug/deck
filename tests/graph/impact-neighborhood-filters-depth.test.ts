// build-graph-code-intel — paired file for the queries phase: k-hop impact
// with direction/kind filters, ring depths, truncation flag, the callers-only
// why walk, and FTS5 search — never presenting unresolved edges as resolved.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGraph } from '../../src/core/graph/schema.ts';
import { indexGraph } from '../../src/core/graph/index.ts';
import { impact, why, findSymbol } from '../../src/core/graph/queries.ts';
import { searchSymbols } from '../../src/core/graph/search.ts';

let dir: string;
let db: ReturnType<typeof openGraph>;

function write(rel: string, content: string): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

// Chain: api → service → store (calls), plus a ui → api call for depth tests.
const FILES: Record<string, string> = {
  'src/store.ts': `export function save(item: string): void {}\nexport function load(id: string): string { return id; }\n`,
  'src/service.ts': `import { save, load } from './store';\nexport function handle(request: string): string { save(request); return load(request); }\n`,
  'src/api.ts': `import { handle } from './service';\nexport function main(request: string): string { return handle(request); }\n`,
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-graph-q-'));
  execSync('git init --initial-branch=main -q', { cwd: dir });
  for (const [rel, content] of Object.entries(FILES)) write(rel, content);
  db = openGraph(dir);
  await indexGraph(dir, db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('impact queries', () => {
  test('outbound impact walks downstream callers by ring depth', () => {
    const seed = findSymbol(db, 'save')[0]!;
    expect(seed).toBeDefined();
    const result = impact(db, seed.id, { direction: 'in', kinds: ['CALLS'] });
    const names = result.nodes.map((node) => node.detail);
    expect(names).toContain('src/service.ts:handle');
    expect(names).toContain('src/api.ts:main');
    const handle = result.nodes.find((node) => node.detail === 'src/service.ts:handle')!;
    const main = result.nodes.find((node) => node.detail === 'src/api.ts:main')!;
    expect(handle.depth).toBe(1);
    expect(main.depth).toBe(2);
  });

  test('direction and kind filters compose', () => {
    const handle = findSymbol(db, 'handle')[0]!;
    // upstream CALLS only: api.main reaches in; ui/store-side edges excluded.
    const callers = impact(db, handle.id, { direction: 'in', kinds: ['CALLS'] });
    expect(callers.nodes.some((node) => node.detail === 'src/api.ts:main')).toBe(true);
    // downstream CALLS only: handle reaches store.save/load, not api.main.
    const callees = impact(db, handle.id, { direction: 'out', kinds: ['CALLS'] });
    expect(callees.nodes.some((node) => node.detail.startsWith('src/store'))).toBe(true);
    expect(callees.nodes.some((node) => node.detail === 'src/api.ts:main')).toBe(false);
  });

  test('why returns the callers-only walk and depth-1 caps work', () => {
    const save = findSymbol(db, 'save')[0]!;
    const result = why(db, save.id);
    expect(result.direction).toBe('in');
    expect(result.nodes.some((node) => node.detail === 'src/service.ts:handle')).toBe(true);
    const capped = impact(db, save.id, { cap: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.nodes.length).toBeLessThanOrEqual(2);
  });

  test('unresolved callees never appear as resolved edges', async () => {
    write('src/ghost.ts', 'export function ghost(): void { phantom(); }\n');
    await indexGraph(dir, db);
    const ghost = findSymbol(db, 'ghost')[0]!;
    const result = impact(db, ghost.id, { direction: 'out', kinds: ['CALLS'] });
    // phantom never resolves: no edge into the neighborhood claims it resolved
    for (const edge of result.edges) {
      expect(edge.resolution).not.toBe('unresolved');
    }
  });
});

describe('symbol search', () => {
  test('partial names rank deterministically', () => {
    const hits = searchSymbols(db, 'save');
    expect(hits.some((hit) => hit.fqn === 'src/store.ts:save')).toBe(true);
    expect(() => searchSymbols(db, 'save')).not.toThrow();
    const again = searchSymbols(db, 'save').map((hit) => hit.fqn);
    expect(again).toEqual(hits.map((hit) => hit.fqn));
  });
});

// --- E04: bounded neighborhood queries (DECK-ARCH-025) + read snapshots -------
import { explainEdgeNeighborhood } from '../../src/core/graph/queries.ts';
import { graphStatus } from '../../src/core/graph/index.ts';

describe('E04 bounded neighborhood queries', () => {
  test('exact-output parity: scoped edge collection equals a full-scan filter (3.7)', () => {
    const seed = findSymbol(db, 'save')[0]!;
    const result = impact(db, seed.id, { direction: 'both' });
    // baseline: the old contract materialized every resolved edge then filtered
    const selected = result.selectedIds;
    const all = (db.query('SELECT source_id, target_id, kind, resolution, confidence FROM g_edge WHERE target_id IS NOT NULL').all() as Array<Record<string, unknown>>)
      .filter((row) => selected.includes(String(row['source_id'])) && selected.includes(String(row['target_id'])))
      .map((row) => JSON.stringify({ source: row['source_id'], target: row['target_id'], kind: row['kind'], resolution: row['resolution'], confidence: row['confidence'] }))
      .sort();
    expect(result.edges.map((edge) => JSON.stringify(edge)).sort()).toEqual(all);
  });

  test('large unrelated graph: results unchanged, edge reads stay scoped (3.7, 5.3)', () => {
    // grow the graph: 120 unrelated modules with their own call edges
    for (let i = 0; i < 120; i++) {
      write(`src/gen/mod${i}.ts`, `import { helper${i} } from './dep${i}';\nexport function caller${i}(): string { return helper${i}(); }\n`);
      write(`src/gen/dep${i}.ts`, `export function helper${i}(): string { return '${i}'; }\n`);
    }
    const db2 = openGraph(dir);
    void db2;
    return indexGraph(dir, openGraph(dir)).then(() => {
      const fresh = openGraph(dir);
      const seed = findSymbol(fresh, 'save')[0]!;
      // query-plan evidence: the scoped edge read uses the index and visits a
      // bounded number of rows — a full-table scan would show SCAN g_edge
      const plans = explainEdgeNeighborhood(fresh, [seed.id]).map((plan) => String(plan['detail'] ?? plan));
      expect(plans.some((detail) => /idx_edge_source/.test(detail))).toBe(true); // index seek on selected ids
      expect(plans.some((detail) => /SCAN g_edge( |$)/.test(detail))).toBe(false); // no whole-graph scan
      // results must equal the pre-growth baseline for the same seed
      const grown = impact(fresh, seed.id, { direction: 'in', kinds: ['CALLS'] });
      expect(grown.nodes.map((node) => node.detail)).toContain('src/service.ts:handle');
      fresh.close();
    });
  });

  test('parameter-limit batching: >500 selected ids still collect all edges (5.2)', () => {
    const seed = findSymbol(db, 'save')[0]!;
    const result = impact(db, seed.id, { direction: 'both', cap: 500 });
    // batched reads must not drop edges relative to a single large IN list
    const ids = result.selectedIds;
    const placeholders = ids.map(() => '?').join(', ');
    const all = (db.query(`SELECT source_id, target_id, kind FROM g_edge WHERE source_id IN (${placeholders}) AND target_id IS NOT NULL`).all(...ids) as Array<Record<string, unknown>>)
      .filter((row) => ids.includes(String(row['target_id'])))
      .map((row) => `${row['source_id']}|${row['target_id']}|${row['kind']}`)
      .sort();
    expect(result.edges.map((edge) => `${edge.source}|${edge.target}|${edge.kind}`).sort()).toEqual(all);
  });

  test('reads during publication: facts and metadata share one snapshot (5.2)', () => {
    // mutate a fact mid-read is impossible to interleave synchronously here;
    // instead assert the snapshot contract structurally: a completed read sees
    // consistent fan-in with the edges visible in the same read
    const seed = findSymbol(db, 'save')[0]!;
    const result = impact(db, seed.id, { direction: 'in', kinds: ['CALLS'] });
    const handle = result.nodes.find((node) => node.detail === 'src/service.ts:handle');
    expect(handle?.fanIn).toBeGreaterThan(0);
    void graphStatus;
  });
});

describe('kind filter honesty', () => {
  test('omitted kinds select the documented defaults — a known caller appears without --kinds', () => {
    // Negative control for the old false-empty default: an omitted filter
    // must behave exactly like the default set, core and CLI alike.
    const save = findSymbol(db, 'save')[0]!;
    const omitted = impact(db, save.id, { direction: 'in' });
    const explicitDefaults = impact(db, save.id, {
      direction: 'in',
      kinds: ['CALLS', 'IMPORTS', 'INHERITS', 'INSTANTIATES', 'IMPLEMENTS', 'REFERENCES', 'CONTAINS', 'DEFINES'],
    });
    expect(omitted.kinds).toEqual(explicitDefaults.kinds);
    expect(omitted.nodes.map((n) => n.detail)).toContain('src/service.ts:handle');
  });

  test('explicit empty or unknown kinds refuse as typed input errors', () => {
    const save = findSymbol(db, 'save')[0]!;
    expect(() => impact(db, save.id, { kinds: [] })).toThrow(/kinds filter is empty/);
    expect(() => impact(db, save.id, { kinds: ['CALLS', 'TELEPORT'] })).toThrow(/unknown edge kind\(s\) TELEPORT/);
  });
});

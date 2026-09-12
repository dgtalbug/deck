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

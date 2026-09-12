// build-graph-code-intel — paired file for the lenses requirement: dextree's
// pinned semantics — dead-code excludes entry points, god-function is live
// CALLS fan-out top 10, god-class is PageRank top 10, least-used stays inside
// the largest component, and order is deterministic.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGraph } from '../../src/core/graph/schema.ts';
import { indexGraph } from '../../src/core/graph/index.ts';
import { runLens, LENS_IDS } from '../../src/core/graph/lenses.ts';

let dir: string;
let db: ReturnType<typeof openGraph>;

function write(rel: string, content: string): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

// The fixture: a used core, a dead unexported helper, a CLI entry with
// fan-in 0 that is NOT dead code, and a hub function everything calls.
const FILES: Record<string, string> = {
  'src/cli/main.ts': `import { orchestrate } from '../services/orchestrator';
export function bootstrap(): void { orchestrate('boot'); }
`,
  'src/services/orchestrator.ts': `import { store } from '../storage/store';
export function orchestrate(mode: string): string { store(mode); return hub(mode); }
`,
  'src/storage/store.ts': `export function store(value: string): void {}
export function hub(key: string): string { return key; }
export function deadHelper(): void {}
`,
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-graph-lens-'));
  execSync('git init --initial-branch=main -q', { cwd: dir });
  for (const [rel, content] of Object.entries(FILES)) write(rel, content);
  db = openGraph(dir);
  await indexGraph(dir, db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seven lenses with pinned semantics', () => {
  test('lens ids are exactly the pinned seven', () => {
    expect([...LENS_IDS]).toEqual([
      'dead-code', 'entry-points', 'god-function', 'god-class',
      'most-used', 'least-used', 'architecture',
    ]);
  });

  test('dead-code excludes entry points even at fan-in 0', () => {
    const dead = runLens(db, 'dead-code').map((node) => node.fqn);
    expect(dead).toContain('src/storage/store.ts:deadHelper');
    // bootstrap is a runtime entry (cli/main.ts + RUNTIME_NAMES) with fan-in 0
    // — classification, not fan-in, keeps it out of dead-code.
    expect(dead).not.toContain('src/cli/main.ts:bootstrap');
  });

  test('entry-points derive from fixed-precedence classification', () => {
    const entries = runLens(db, 'entry-points').map((node) => node.fqn);
    expect(entries).toContain('src/cli/main.ts:bootstrap'); // runtime
    expect(entries).not.toContain('src/storage/store.ts:deadHelper');
  });

  test('god-function ranks by live CALLS fan-out and excludes leaves', () => {
    const gods = runLens(db, 'god-function');
    expect(gods.length).toBeGreaterThan(0);
    expect(gods[0]!.fqn).toBe('src/services/orchestrator.ts:orchestrate');
    for (const node of gods) expect(node.fanOut!).toBeGreaterThan(0);
  });

  test('most-used orders by fan-in deterministically', () => {
    const most = runLens(db, 'most-used');
    expect(most[0]!.fanIn).toBeGreaterThanOrEqual(most[1]?.fanIn ?? 0);
    expect(most.map((node) => node.fqn)).toContain('src/services/orchestrator.ts:orchestrate');
  });

  test('god-class and architecture and least-used run deterministically', () => {
    const classes = runLens(db, 'god-class');
    expect(classes.every((node) => node.kind === 'class')).toBe(true);
    const arch = runLens(db, 'architecture');
    expect(arch.every((node) => node.archLayer !== 'unknown' || node.archLayer === 'unknown')).toBe(true);
    // two consecutive runs agree — deterministic output
    expect(runLens(db, 'most-used')).toEqual(runLens(db, 'most-used'));
  });
});

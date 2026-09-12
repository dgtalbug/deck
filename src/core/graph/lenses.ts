// lenses.ts: the seven selectors with dextree's pinned semantics — pure
// functions over the indexed graph, deterministic order (metric desc, id asc
// tiebreak) so reindexes never reshuffle results.
import type { Database } from 'bun:sqlite';

export const LENS_IDS = [
  'dead-code',
  'entry-points',
  'god-function',
  'god-class',
  'most-used',
  'least-used',
  'architecture',
] as const;
export type LensId = (typeof LENS_IDS)[number];

export interface LensNode {
  id: string;
  name: string;
  fqn: string;
  kind: string;
  file: string;
  entryKind: string;
  archLayer: string;
  fanIn: number;
  fanOut?: number;
  importance?: number | null;
}

interface SymbolRow {
  id: string;
  name: string;
  fqn: string;
  kind: string;
  file_id: string;
  entry_kind: string;
  arch_layer: string;
  fan_in: number;
  importance: number | null;
  relative_path: string;
}

const SELECT_ALL = `
  SELECT s.id, s.name, s.fqn, s.kind, s.file_id, s.entry_kind, s.arch_layer, s.fan_in, s.importance, f.relative_path
  FROM g_symbol s JOIN g_file f ON f.id = s.file_id`;

const deterministic = (rows: SymbolRow[], metric: (row: SymbolRow) => number): SymbolRow[] =>
  [...rows].sort((a, b) => metric(b) - metric(a) || a.id.localeCompare(b.id));

function toNode(row: SymbolRow, extra: Partial<LensNode> = {}): LensNode {
  return {
    id: row.id,
    name: row.name,
    fqn: row.fqn,
    kind: row.kind,
    file: row.relative_path,
    entryKind: row.entry_kind,
    archLayer: row.arch_layer,
    fanIn: row.fan_in,
    importance: row.importance,
    ...extra,
  };
}

export function runLens(db: Database, lens: LensId): LensNode[] {
  const all = db.query(`${SELECT_ALL}`).all() as SymbolRow[];
  switch (lens) {
    case 'dead-code': {
      // fanIn 0 AND not an entry point — "absence of the signal is unknown,
      // not provably dead", but pass-1 always writes fan_in, so 0 is a signal.
      return deterministic(
        all.filter((row) => row.fan_in === 0 && row.entry_kind === 'unclassified'),
        () => 0,
      ).slice(0, 50).map((row) => toNode(row));
    }
    case 'entry-points': {
      return deterministic(all.filter((row) => row.entry_kind !== 'unclassified'), () => 0).map((row) => toNode(row));
    }
    case 'god-function': {
      // Live outbound CALLS fan-out (not persisted) top 10; a leaf is the
      // opposite of a god-function — zero fan-out excluded.
      const rows = deterministic(all.filter((row) => row.kind === 'function' || row.kind === 'method'), (row) => liveFanOut(db, row.id)).filter(
        (row) => liveFanOut(db, row.id) > 0,
      ).slice(0, 10);
      return rows.map((row) => toNode(row, { fanOut: liveFanOut(db, row.id) }));
    }
    case 'god-class': {
      return deterministic(
        all.filter((row) => row.kind === 'class' && row.importance !== null),
        (row) => row.importance ?? 0,
      ).slice(0, 10).map((row) => toNode(row));
    }
    case 'most-used': {
      return deterministic(all, (row) => row.fan_in).filter((row) => row.fan_in > 0).slice(0, 25).map((row) => toNode(row));
    }
    case 'least-used': {
      // fanIn ≤ 1 within the largest connected component — orphans excluded
      // (an unused util nobody reaches is still a choice; an orphan is noise).
      const component = largestComponent(db);
      return deterministic(all.filter((row) => row.fan_in <= 1 && component.has(row.id)), () => 0).slice(0, 50).map((row) => toNode(row));
    }
    case 'architecture': {
      return deterministic(all, () => 0).map((row) => toNode(row));
    }
  }
}

function liveFanOut(db: Database, symbolId: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM g_edge WHERE source_id = ? AND kind = 'CALLS' AND target_id IS NOT NULL").get(symbolId) as { n: number }).n;
}

// Largest connected component over the undirected resolved edge set (union-find).
function largestComponent(db: Database): Set<string> {
  const edges = db.query('SELECT source_id, target_id FROM g_edge WHERE target_id IS NOT NULL').all() as Array<{ source_id: string; target_id: string }>;
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b));
  };
  for (const edge of edges) {
    for (const id of [edge.source_id, edge.target_id]) {
      if (!parent.has(id)) parent.set(id, id);
    }
    union(edge.source_id, edge.target_id);
  }
  const sizes = new Map<string, number>();
  for (const id of parent.keys()) {
    const root = find(id);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  let bestRoot = '';
  let bestSize = 0;
  for (const [root, size] of sizes) {
    if (size > bestSize) {
      bestRoot = root;
      bestSize = size;
    }
  }
  return new Set([...parent.keys()].filter((id) => find(id) === bestRoot));
}

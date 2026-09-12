// queries.ts: k-hop impact and the callers walk over the indexed edge table —
// recursive CTEs, cycle-guarded via the path string, node-capped with an
// explicit truncation flag. Only resolved edges are traversed, and every node
// carries its ring depth; unresolved edges are never presented as resolved.
import type { Database } from 'bun:sqlite';

export interface ImpactNode {
  id: string;
  kind: 'file' | 'symbol';
  name: string;
  detail: string; // fqn for symbols, relative_path for files
  depth: number;
  fanIn: number | null;
  importance: number | null;
}

export interface ImpactResult {
  seed: string;
  direction: 'in' | 'out' | 'both';
  nodes: ImpactNode[];
  edges: Array<{ source: string; target: string; kind: string; resolution: string; confidence: number }>;
  truncated: boolean;
  cap: number;
}

const DEFAULT_CAP = 500;

// Seed resolution: symbol name or fqn → candidate ids, most-connected first.
export function findSymbol(db: Database, seed: string): Array<{ id: string; name: string; fqn: string; file_id: string }> {
  return db.query('SELECT id, name, fqn, file_id FROM g_symbol WHERE name = ? OR fqn = ? ORDER BY fan_in DESC, fqn LIMIT 10').all(seed, seed) as Array<{ id: string; name: string; fqn: string; file_id: string }>;
}

const STEPS: Record<'in' | 'out' | 'both', { join: string; next: string }> = {
  in: { join: 'JOIN g_edge e ON e.target_id = frontier.node_id', next: 'e.source_id' },
  out: { join: 'JOIN g_edge e ON e.source_id = frontier.node_id', next: 'e.target_id' },
  both: {
    join: 'JOIN g_edge e ON (e.target_id = frontier.node_id OR e.source_id = frontier.node_id)',
    next: 'CASE WHEN e.target_id = frontier.node_id THEN e.source_id ELSE e.target_id END',
  },
};

export function impact(
  db: Database,
  seedId: string,
  options: { direction?: 'in' | 'out' | 'both'; maxDepth?: number; kinds?: string[]; cap?: number } = {},
): ImpactResult {
  const direction = options.direction ?? 'both';
  const maxDepth = options.maxDepth ?? 2;
  const cap = options.cap ?? DEFAULT_CAP;
  const kinds = options.kinds ?? ['CALLS', 'IMPORTS', 'INHERITS', 'INSTANTIATES', 'IMPLEMENTS', 'REFERENCES', 'CONTAINS', 'DEFINES'];
  const step = STEPS[direction];
  const next = step.next;
  const sql = `
    WITH RECURSIVE frontier(node_id, depth, path) AS (
      SELECT ?, 0, ?
      UNION ALL
      SELECT ${next}, frontier.depth + 1, frontier.path || '>' || ${next}
      FROM frontier
      ${step.join}
      WHERE e.target_id IS NOT NULL
        AND e.kind IN (${kinds.map((kind) => `'${kind}'`).join(', ')})
        AND frontier.depth < ?
        AND instr(frontier.path, ${next}) = 0
    )
    SELECT DISTINCT node_id, MIN(depth) AS depth
    FROM frontier WHERE node_id != ?
    GROUP BY node_id ORDER BY depth, node_id LIMIT ?`;
  const rows = db.prepare(sql).all(seedId, seedId, maxDepth, seedId, cap + 1) as Array<{ node_id: string; depth: number }>;
  const truncated = rows.length > cap;
  const hit = rows.slice(0, cap);
  const nodes: ImpactNode[] = [];
  for (const row of hit) {
    const symbol = db.query('SELECT name, fqn, fan_in, importance FROM g_symbol WHERE id = ?').get(row.node_id) as
      | { name: string; fqn: string; fan_in: number; importance: number | null }
      | null;
    if (symbol !== null) {
      nodes.push({ id: row.node_id, kind: 'symbol', name: symbol.name, detail: symbol.fqn, depth: row.depth, fanIn: symbol.fan_in, importance: symbol.importance });
      continue;
    }
    const file = db.query('SELECT relative_path FROM g_file WHERE id = ?').get(row.node_id) as { relative_path: string } | null;
    if (file !== null) {
      nodes.push({ id: row.node_id, kind: 'file', name: file.relative_path.split('/').pop() ?? file.relative_path, detail: file.relative_path, depth: row.depth, fanIn: null, importance: null });
    }
  }
  const edges = edgesAmong(db, [seedId, ...hit.map((row) => row.node_id)]);
  return { seed: seedId, direction, nodes, edges, truncated, cap };
}

// why = the callers-only walk (upstream impact): who reaches this symbol.
export function why(db: Database, seedId: string, cap = DEFAULT_CAP): ImpactResult {
  return impact(db, seedId, { direction: 'in', kinds: ['CALLS', 'REFERENCES'], cap });
}

function edgesAmong(db: Database, ids: string[]): ImpactResult['edges'] {
  const set = new Set(ids);
  const rows = db.query('SELECT source_id, target_id, kind, resolution, confidence FROM g_edge WHERE target_id IS NOT NULL').all() as Array<{
    source_id: string;
    target_id: string;
    kind: string;
    resolution: string;
    confidence: number;
  }>;
  return rows
    .filter((row) => set.has(row.source_id) && set.has(row.target_id))
    .map((row) => ({ source: row.source_id, target: row.target_id, kind: row.kind, resolution: row.resolution, confidence: row.confidence }));
}

import type { Database } from 'bun:sqlite';
import { GraphInputError } from './envelope.ts';

export interface ImpactNode {
  id: string;
  kind: 'file' | 'symbol';
  name: string;
  detail: string;
  depth: number;
  fanIn: number | null;
  importance: number | null;
}

export interface ImpactResult {
  seed: string;
  direction: 'in' | 'out' | 'both';
  kinds: string[];
  nodes: ImpactNode[];
  edges: Array<{ source: string; target: string; kind: string; resolution: string; confidence: number }>;
  truncated: boolean;
  cap: number;
  selectedIds: string[];
  uncertainty: {
    structural: number;
    heuristic: number;
    ambiguous: number;
    unresolved: number;
    unresolvedNames: string[];
    candidatesTruncated: boolean;
  };
}

export const DEFAULT_GRAPH_KINDS = ['CALLS', 'IMPORTS', 'INHERITS', 'INSTANTIATES', 'IMPLEMENTS', 'REFERENCES', 'CONTAINS', 'DEFINES'] as const;

// Omitted kinds select the documented defaults everywhere (core, CLI, MCP).
// An explicit empty list or an unknown kind is a typed usage error, never a
// silent false-empty result.
export function normalizeKinds(kinds: string[] | undefined): string[] {
  if (kinds === undefined) return [...DEFAULT_GRAPH_KINDS];
  if (kinds.length === 0) {
    throw new GraphInputError(
      `kinds filter is empty — omit --kinds to use the defaults (${DEFAULT_GRAPH_KINDS.join(',').toLowerCase()})`,
    );
  }
  const unknown = kinds.filter((kind) => !(DEFAULT_GRAPH_KINDS as readonly string[]).includes(kind));
  if (unknown.length > 0) {
    throw new GraphInputError(
      `unknown edge kind(s) ${unknown.join(', ')} — valid kinds: ${DEFAULT_GRAPH_KINDS.join(', ').toLowerCase()}`,
    );
  }
  return kinds;
}

const DEFAULT_CAP = 500;
export const EDGE_BATCH_SIZE = 500;

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
  options: { direction?: 'in' | 'out' | 'both'; maxDepth?: number; kinds?: string[] | undefined; cap?: number } = {},
): ImpactResult {
  const direction = options.direction ?? 'both';
  const maxDepth = options.maxDepth ?? 2;
  const cap = options.cap ?? DEFAULT_CAP;
  const kinds = normalizeKinds(options.kinds);
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
  const tx = db.transaction((run: () => ImpactResult) => run());
  return tx(() => {
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
    const selectedIds = [seedId, ...hit.map((row) => row.node_id)];
    const edges = edgesAmong(db, selectedIds);
    const uncertainty = uncertaintyFor(db, seedId);
    return { seed: seedId, direction, kinds, nodes, edges, truncated, cap, selectedIds, uncertainty };
  });
}

// Uncertainty observed at the seed itself: resolution tiers over the seed's
// outgoing edges (including unresolved edges with no traversable target),
// ambiguous-candidate counts and the referenced-but-unresolved names.
function uncertaintyFor(db: Database, seedId: string): ImpactResult['uncertainty'] {
  const tiers = db
    .query(
      `SELECT resolution, COUNT(*) AS n FROM g_edge WHERE source_id = ? GROUP BY resolution`,
    )
    .all(seedId) as Array<{ resolution: string; n: number }>;
  const by = new Map(tiers.map((row) => [row.resolution, row.n]));
  const ambiguousRows = db
    .query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(json_extract(meta, '$.candidateCount') > 5), 0) AS over
       FROM g_edge WHERE source_id = ? AND json_extract(meta, '$.ambiguous') = 1`,
    )
    .get(seedId) as { n: number; over: number };
  const names = db
    .query(
      `SELECT DISTINCT json_extract(meta, '$.callee_name') AS name FROM g_edge
       WHERE source_id = ? AND target_id IS NULL AND json_extract(meta, '$.callee_name') IS NOT NULL
       ORDER BY name LIMIT 51`,
    )
    .all(seedId) as Array<{ name: string }>;
  return {
    structural: by.get('structural') ?? 0,
    heuristic: by.get('heuristic') ?? 0,
    ambiguous: ambiguousRows.n,
    unresolved: by.get('unresolved') ?? 0,
    unresolvedNames: names.slice(0, 50).map((row) => row.name),
    candidatesTruncated: ambiguousRows.over > 0 || names.length > 50,
  };
}

export function why(db: Database, seedId: string, cap = DEFAULT_CAP): ImpactResult {
  return impact(db, seedId, { direction: 'in', kinds: ['CALLS', 'REFERENCES'], cap });
}

function edgesAmong(db: Database, ids: string[], batchSize = EDGE_BATCH_SIZE): ImpactResult['edges'] {
  const set = new Set(ids);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) chunks.push(ids.slice(i, i + batchSize));
  const rows: Array<{ source_id: string; target_id: string; kind: string; resolution: string; confidence: number }> = [];
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(', ');
    rows.push(
      ...db
        .query(
          `SELECT source_id, target_id, kind, resolution, confidence FROM g_edge ` +
            `WHERE source_id IN (${placeholders}) AND target_id IS NOT NULL ` +
            'ORDER BY source_id, target_id, kind',
        )
        .all(...chunk) as typeof rows,
    );
  }
  return rows
    .filter((row) => set.has(row.source_id) && set.has(row.target_id))
    .map((row) => ({ source: row.source_id, target: row.target_id, kind: row.kind, resolution: row.resolution, confidence: row.confidence }));
}

export function explainEdgeNeighborhood(db: Database, ids: string[]): Array<Record<string, unknown>> {
  const chunk = ids.slice(0, EDGE_BATCH_SIZE);
  const placeholders = chunk.map(() => '?').join(', ');
  return db
    .query(`EXPLAIN QUERY PLAN SELECT source_id, target_id, kind FROM g_edge WHERE source_id IN (${placeholders}) AND target_id IS NOT NULL ORDER BY source_id, target_id, kind`)
    .all(...chunk) as Array<Record<string, unknown>>;
}

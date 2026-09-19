import type { Database } from 'bun:sqlite';
import { readMeta, type GraphStatus } from './schema.ts';
import { EXTRACTOR_VERSION, RESOLUTION_VERSION } from './index.ts';

export const GRAPH_ENVELOPE_VERSION = 1;

// Refusals that carry an action, never a silent empty result.
export class GraphInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphInputError';
  }
}

export class StaleGraphError extends Error {
  readonly state: GraphStatus['state'];
  constructor(state: GraphStatus['state'], reason: string | null) {
    super(
      `graph is ${state}${reason !== null ? ` — ${reason}` : ''}; refresh with 'deck graph index' ` +
        `or pass explicit stale-inspection to read it labeled as stale`,
    );
    this.name = 'StaleGraphError';
    this.state = state;
  }
}

export class GenerationChangedError extends Error {
  constructor(generationBefore: number, generationAfter: number) {
    super(
      `graph generation changed during the query (${generationBefore} → ${generationAfter}) — ` +
        `rerun for one consistent generation`,
    );
    this.name = 'GenerationChangedError';
  }
}

export interface GraphEnvelope<T> {
  envelopeVersion: number;
  workspace: { path: string; origin: string | null };
  identity: {
    fingerprint: string | null;
    generation: number;
    schemaVersion: number;
    extractorVersion: number;
    resolverVersion: number;
  };
  freshness: { state: GraphStatus['state']; reason: string | null; lastIndex: string | null; staleInspection: boolean };
  query: Record<string, unknown>;
  counts: {
    nodes: number;
    edges: number;
    structural: number;
    heuristic: number;
    ambiguous: number;
    unresolved: number;
  };
  unresolvedNames: string[];
  truncated: boolean;
  result: T;
}

export interface EnvelopeInput<T> {
  projectPath: string;
  origin: string | null;
  status: GraphStatus;
  query: Record<string, unknown>;
  truncated: boolean;
  staleInspection?: boolean;
  generationBefore: number;
  result: T;
}

// Absent, stale or unverifiable graphs refuse by default with an action;
// explicit stale inspection passes through visibly labeled.
export function assertFreshEnough(status: GraphStatus, options: { allowStale?: boolean } = {}): void {
  if (status.state === 'ready') return;
  if (options.allowStale === true) return;
  throw new StaleGraphError(status.state, status.reason ?? null);
}

export function buildEnvelope<T>(db: Database, input: EnvelopeInput<T>): GraphEnvelope<T> {
  const metaAfter = readMeta(db);
  const generationAfter = metaAfter?.generation ?? 0;
  if (metaAfter !== null && generationAfter !== input.generationBefore) {
    throw new GenerationChangedError(input.generationBefore, generationAfter);
  }
  const resolutionCounts = countEdgeResolutions(db);
  return {
    envelopeVersion: GRAPH_ENVELOPE_VERSION,
    workspace: { path: input.projectPath, origin: input.origin },
    identity: {
      fingerprint: metaAfter?.inputFingerprint ?? null,
      generation: generationAfter,
      schemaVersion: metaAfter?.schemaVersion ?? 0,
      extractorVersion: EXTRACTOR_VERSION,
      resolverVersion: RESOLUTION_VERSION,
    },
    freshness: {
      state: input.status.state,
      reason: input.status.reason ?? null,
      lastIndex: metaAfter?.lastIndex ?? null,
      staleInspection: input.staleInspection === true,
    },
    query: input.query,
    counts: resolutionCounts,
    unresolvedNames: listUnresolvedNames(db),
    truncated: input.truncated,
    result: input.result,
  };
}

// Resolution summaries cover the whole published graph — including unresolved
// edges with no traversable target — so counts never imply completeness of a
// traversed neighborhood.
function countEdgeResolutions(db: Database): GraphEnvelope<unknown>['counts'] {
  const rows = db
    .query(
      `SELECT resolution, COUNT(*) AS n FROM g_edge GROUP BY resolution`,
    )
    .all() as Array<{ resolution: string; n: number }>;
  const by = new Map(rows.map((row) => [row.resolution, row.n]));
  const ambiguous = (
    db.query(`SELECT COUNT(*) AS n FROM g_edge WHERE json_extract(meta, '$.ambiguous') = 1`).get() as { n: number }
  ).n;
  const nodes = (db.query('SELECT COUNT(*) AS n FROM g_symbol').get() as { n: number }).n;
  return {
    nodes,
    edges: rows.reduce((sum, row) => sum + row.n, 0),
    structural: by.get('structural') ?? 0,
    heuristic: by.get('heuristic') ?? 0,
    ambiguous,
    unresolved: by.get('unresolved') ?? 0,
  };
}

function listUnresolvedNames(db: Database, cap = 50): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT json_extract(meta, '$.callee_name') AS name FROM g_edge
       WHERE target_id IS NULL AND json_extract(meta, '$.callee_name') IS NOT NULL
       ORDER BY name LIMIT ?`,
    )
    .all(cap) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

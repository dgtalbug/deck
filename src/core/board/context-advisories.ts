import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentStore } from './store.ts';
import { readSourceBaseline, compareSourceBaseline } from './source-baselines.ts';
import { readFileSync } from 'node:fs';
import { retrieveReferences, type CorpusFile } from './context-retrieval.ts';
import { openGraph, readMeta } from '../graph/schema.ts';
import { graphStatus } from '../graph/index.ts';
import { findSymbol, impact } from '../graph/queries.ts';

export type AdvisoryStrategy = 'baseline' | 'graph';

export type AdvisoryState =
  | 'ok'
  | 'fallback-graph-missing'
  | 'fallback-graph-stale'
  | 'no-baseline';

export interface AdvisoryOutcome {
  strategy: AdvisoryStrategy;
  state: AdvisoryState;
  references: string[];
  truncated: boolean;
  body: string;
}

const GRAPH_NEIGHBOR_CAP = 40;

function currentCorpus(store: DocumentStore, paths: string[]): CorpusFile[] {
  return paths.map((path) => {
    const absolute = join(store.projectPath, path);
    return { path, bytes: existsSync(absolute) ? readFileSync(absolute, 'utf8') : null };
  });
}

function tierFor(confidence: number, resolution: string): string {
  if (resolution === 'unresolved' || confidence === 0) return 'unresolved';
  if (confidence >= 1) return 'structural';
  return 'heuristic';
}

// One freshness policy for every consumer: the shared graphStatus check
// (schema, workspace origin, completeness, and current source fingerprint).
function graphFreshness(store: DocumentStore, cardId: string): 'ok' | 'graph-missing' | 'graph-stale' {
  const graphPath = join(store.projectPath, '.deck', 'graph.sqlite');
  if (!existsSync(graphPath)) return 'graph-missing';
  const graph = openGraph(store.projectPath);
  try {
    const status = graphStatus(store.projectPath, graph);
    if (status.state === 'absent') return 'graph-missing';
    if (status.state !== 'ready') return 'graph-stale';
    const meta = readMeta(graph);
    const baseline = readSourceBaseline(store.db, cardId)[0];
    if (baseline?.graphGeneration !== null && baseline?.graphGeneration !== undefined && meta !== null && baseline.graphGeneration > meta.generation) return 'graph-stale';
    return 'ok';
  } finally {
    graph.close();
  }
}

// Renders the optional retrieval advisory. Tier labels stay attached to every
// graph neighbor so heuristic matches can never masquerade as resolved edges;
// a missing or stale graph falls back to baseline retrieval and says so.
export function buildAdvisory(store: DocumentStore, cardId: string, query: string, strategy: AdvisoryStrategy): AdvisoryOutcome | null {
  const baseline = readSourceBaseline(store.db, cardId);
  if (baseline.length === 0) {
    return { strategy, state: 'no-baseline', references: [], truncated: false, body: 'no source baseline captured for this card — run baseline capture first' };
  }
  const corpus = currentCorpus(store, baseline.map((row) => row.path));
  const baseRanked = retrieveReferences(query, corpus, 10);
  const changes = compareSourceBaseline(store, cardId);

  if (strategy === 'baseline') {
    return { strategy, state: 'ok', references: baseRanked.map((r) => r.reference), truncated: false, body: renderBaseline(baseRanked.map((r) => r.reference), changes) };
  }

  const freshness = graphFreshness(store, cardId);
  if (freshness !== 'ok') {
    const state: AdvisoryState = freshness === 'graph-missing' ? 'fallback-graph-missing' : 'fallback-graph-stale';
    const reason = freshness === 'graph-missing' ? 'graph data is absent' : 'graph data is stale or incomplete';
    return {
      strategy,
      state,
      references: baseRanked.map((r) => r.reference),
      truncated: false,
      body: [`graph retrieval unavailable: ${reason} — baseline path/keyword fallback follows (no fresh graph evidence claimed)`, renderBaseline(baseRanked.map((r) => r.reference), changes)].join('\n'),
    };
  }

  const graph = openGraph(store.projectPath);
  try {
    const ranked = rankGraphNeighbors(graph, baseRanked);
    const meta = readMeta(graph)!;
    const header = `graph retrieval (generation ${meta.generation}${meta.inputFingerprint !== null ? `, fingerprint ${meta.inputFingerprint.slice(0, 12)}` : ''}) — ${ranked.truncated ? `top ${ranked.references.length} of ${ranked.total}` : `${ranked.references.length} neighbor(s)`}`;
    return {
      strategy,
      state: 'ok',
      references: ranked.references.map((r) => r.reference),
      truncated: ranked.truncated,
      body: [header, ...ranked.references.map((r) => `- ${r.reference} [${r.tier}]`), ...changeLines(changes)].join('\n'),
    };
  } finally {
    graph.close();
  }
}

function renderBaseline(references: string[], changes: ReturnType<typeof compareSourceBaseline>): string {
  const lines = references.length > 0 ? references.map((reference) => `- ${reference}`) : ['- (no keyword matches in the selected corpus)'];
  return ['path/keyword retrieval over the selected corpus', ...lines, ...changeLines(changes)].join('\n');
}

function changeLines(changes: ReturnType<typeof compareSourceBaseline>): string[] {
  if (changes.length === 0) return [];
  const relevant = changes.filter((change) => change.status !== 'unchanged');
  if (relevant.length === 0) return ['source changes vs baseline: none (all selected files unchanged)'];
  return [
    'source changes vs baseline (advisory only — a changed byte does not gate execution):',
    ...relevant.map((change) => {
      if (change.status === 'unavailable') return `- ${change.path} — COMPARISON UNAVAILABLE (historical bytes cannot be retrieved)`;
      if (change.status === 'renamed') return `- ${change.path} → ${change.renamedTo} — RENAMED (bytes identical to baseline ${change.baselineDigest.slice(0, 8)})`;
      if (change.status === 'deleted') return `- ${change.path} — DELETED since baseline ${change.baselineDigest.slice(0, 8)}`;
      return `- ${change.path} — CHANGED baseline=${change.baselineDigest.slice(0, 8)} current=${change.currentDigest?.slice(0, 8)}`;
    }),
  ];
}

function rankGraphNeighbors(graph: ReturnType<typeof openGraph>, seeds: Array<{ reference: string }>): { references: Array<{ reference: string; tier: string }>; truncated: boolean; total: number } {
  const seedNames = [...new Set(seeds.map((seed) => seed.reference.split(':').pop()!).filter((name) => name.length > 0))];
  const seedIds = new Set<string>();
  for (const name of seedNames) {
    for (const symbol of findSymbol(graph, name)) seedIds.add(symbol.id);
  }
  const collected = new Map<string, { reference: string; tier: string; importance: number }>();
  for (const seedId of seedIds) {
    const result = impact(graph, seedId, { direction: 'both', maxDepth: 1, cap: GRAPH_NEIGHBOR_CAP });
    for (const node of result.nodes) {
      if (node.kind !== 'symbol') continue;
      const file = graph.query('SELECT relative_path FROM g_file WHERE id = ?').get(node.id) as { relative_path: string } | null
        ?? graph.query('SELECT relative_path FROM g_file WHERE id = (SELECT file_id FROM g_symbol WHERE id = ?)').get(node.id) as { relative_path: string } | null;
      const path = file?.relative_path;
      if (path === undefined || path === null) continue;
      const edge = result.edges
        .filter((e) => e.source === node.id || e.target === node.id)
        .reduce<(typeof result.edges)[number] | undefined>((best, candidate) => best === undefined || candidate.confidence > best.confidence ? candidate : best, undefined);
      const tier = edge === undefined ? 'unresolved' : tierFor(edge.confidence, edge.resolution);
      const reference = `${path}:${node.name}`;
      const importance = node.importance ?? node.fanIn ?? 0;
      const existing = collected.get(reference);
      if (existing === undefined || importance > existing.importance) collected.set(reference, { reference, tier, importance });
    }
  }
  const all = [...collected.values()].sort((a, b) => b.importance - a.importance || (a.reference < b.reference ? -1 : 1));
  const limited = all.slice(0, 10);
  return { references: limited, truncated: all.length > limited.length, total: all.length };
}

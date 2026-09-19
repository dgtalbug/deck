import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from 'bun:sqlite';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';
import { DeckError, StaleWriterError } from './errors.ts';
import { acceptedRevision, currentScopeRevision, scopeClassification } from './accepted-scope.ts';
import { impactApprovals, impactSnapshots } from './schema.ts';
import { openGraph, readMeta, GRAPH_SCHEMA_VERSION } from '../graph/schema.ts';
import { graphStatus, gitOrigin, EXTRACTOR_VERSION, RESOLUTION_VERSION } from '../graph/index.ts';
import { findSymbol, impact, why, type ImpactResult } from '../graph/queries.ts';
import { assertFreshEnough, GRAPH_ENVELOPE_VERSION, StaleGraphError } from '../graph/envelope.ts';

export interface SnapshotSeed {
  symbol: string;
  fqn: string;
  id: string;
}

export interface SnapshotNode {
  id: string;
  kind: 'file' | 'symbol';
  name: string;
  detail: string;
  depth: number;
  fanIn: number | null;
  importance: number | null;
  file: string | null;
  tier: 'structural' | 'heuristic' | 'unresolved';
}

// The immutable evidence body of one impact decision. Everything a reviewer
// needs to reproduce or reject a graph-backed blast-radius claim, including
// the uncertainty that approval must not launder into proof.
export interface SnapshotEvidence {
  envelopeVersion: number;
  workspace: { path: string; origin: string | null };
  identity: {
    fingerprint: string | null;
    generation: number;
    schemaVersion: number;
    extractorVersion: number;
    resolverVersion: number;
  };
  freshness: { state: string; reason: string | null; lastIndex: string | null; staleInspection: boolean };
  query: {
    mode: 'impact' | 'why';
    seeds: SnapshotSeed[];
    direction: 'in' | 'out' | 'both';
    kinds: string[];
    maxDepth: number;
    cap: number;
  };
  nodes: SnapshotNode[];
  edges: ImpactResult['edges'];
  counts: { nodes: number; edges: number; structural: number; heuristic: number; ambiguous: number; unresolved: number };
  unresolvedNames: string[];
  truncated: boolean;
  uncertainty: ImpactResult['uncertainty'];
  fallback: { reason: 'graph-missing' | 'graph-stale' | 'graph-incompatible' | 'graph-unavailable' | null };
  sourceConfirmations: Array<{ path: string; confirmedBy: string; note: string }>;
}

export interface ImpactSnapshotRecord {
  id: string;
  cardId: string;
  basisRevision: number;
  basisRevisionId: string;
  mode: 'graph' | 'fallback';
  actor: string;
  rationale: string;
  capturedAt: string;
  evidence: SnapshotEvidence;
}

export interface ImpactApprovalRecord {
  id: string;
  cardId: string;
  snapshotId: string;
  revision: number;
  revisionId: string;
  actor: string;
  rationale: string;
  acknowledgedUncertainty: string;
  fallbackAcknowledged: boolean;
  approvedAt: string;
}

export class MissingAcceptedRevisionError extends DeckError {
  constructor(cardId: string) {
    super(
      `card ${cardId} has no accepted specification revision — impact snapshots bind to accepted revisions; audit or accept the scope first`,
      { cardId },
    );
  }
}

export class SnapshotNotFoundError extends DeckError {
  constructor(cardId: string, snapshotId: string) {
    super(`no impact snapshot '${snapshotId}' for card ${cardId} — list captured snapshots first`, { cardId, snapshotId });
  }
}

export class CrossCardSnapshotError extends DeckError {
  constructor(cardId: string, snapshotId: string, ownerCardId: string) {
    super(
      `impact snapshot '${snapshotId}' belongs to card ${ownerCardId}, not ${cardId} — approval is card-scoped`,
      { cardId, snapshotId, ownerCardId },
    );
  }
}

export class StaleApprovalBasisError extends StaleWriterError {
  readonly currentRevisionId: string | null;
  constructor(cardId: string, snapshotRevision: number, currentRevision: number, currentRevisionId: string | null) {
    super(`impact basis of ${cardId}`, snapshotRevision, currentRevision);
    this.currentRevisionId = currentRevisionId;
  }
}

export class UncertaintyAcknowledgementError extends DeckError {
  constructor(cardId: string, snapshotId: string) {
    super(
      `impact snapshot '${snapshotId}' carries uncertainty (heuristic, unresolved, ambiguous, truncated, or stale evidence) — ` +
        `approve with an explicit --acknowledge-uncertainty note; approval cannot erase uncertainty`,
      { cardId, snapshotId },
    );
  }
}

export class FallbackAcknowledgementError extends DeckError {
  constructor(cardId: string, snapshotId: string) {
    super(
      `impact snapshot '${snapshotId}' is a source-search fallback, not graph evidence — approve with --acknowledge-fallback`,
      { cardId, snapshotId },
    );
  }
}

export class SeedNotFoundError extends DeckError {
  constructor(seeds: string[]) {
    super(`no graph symbol matches seed(s) ${seeds.join(', ')} — check spelling or index first`, { seeds });
  }
}

function snapshotIdOf(cardId: string, basisRevision: number, evidence: SnapshotEvidence): string {
  return `is-${createHash('sha256').update(`${cardId}\n${basisRevision}\n${JSON.stringify(evidence)}`).digest('hex').slice(0, 12)}`;
}

function decodeSnapshot(row: typeof impactSnapshots.$inferSelect): ImpactSnapshotRecord {
  return {
    id: row.id,
    cardId: row.cardId,
    basisRevision: row.basisRevision,
    basisRevisionId: row.basisRevisionId,
    mode: row.mode,
    actor: row.actor,
    rationale: row.rationale,
    capturedAt: row.capturedAt,
    evidence: JSON.parse(row.evidence) as SnapshotEvidence,
  };
}

function decodeApproval(row: typeof impactApprovals.$inferSelect): ImpactApprovalRecord {
  return {
    id: row.id,
    cardId: row.cardId,
    snapshotId: row.snapshotId,
    revision: row.revision,
    revisionId: row.revisionId,
    actor: row.actor,
    rationale: row.rationale,
    acknowledgedUncertainty: row.acknowledgedUncertainty,
    fallbackAcknowledged: row.fallbackAcknowledged,
    approvedAt: row.approvedAt,
  };
}

export interface CaptureInput {
  cardId: string;
  actor: string;
  rationale: string;
  evidence: SnapshotEvidence;
}

// Persist one immutable snapshot tied to the card's current accepted revision.
// Capture records facts only; acceptance is a separate explicit approval.
export function captureImpactSnapshot(db: SQLiteBunDatabase, input: CaptureInput): ImpactSnapshotRecord {
  if (scopeClassification(db, input.cardId) !== 'accepted') {
    throw new MissingAcceptedRevisionError(input.cardId);
  }
  const current = currentScopeRevision(db, input.cardId);
  const revision = acceptedRevision(db, input.cardId, current);
  if (revision === null) throw new MissingAcceptedRevisionError(input.cardId);
  const mode = input.evidence.fallback.reason !== null ? 'fallback' : 'graph';
  const id = snapshotIdOf(input.cardId, current, input.evidence);
  const capturedAt = new Date().toISOString();
  db.insert(impactSnapshots)
    .values({
      id,
      cardId: input.cardId,
      basisRevision: current,
      basisRevisionId: revision.revisionId,
      mode,
      actor: input.actor,
      rationale: input.rationale,
      evidence: JSON.stringify(input.evidence),
      capturedAt,
    })
    .onConflictDoNothing()
    .run();
  return { id, cardId: input.cardId, basisRevision: current, basisRevisionId: revision.revisionId, mode, actor: input.actor, rationale: input.rationale, capturedAt, evidence: input.evidence };
}

function tierFor(confidence: number, resolution: string): SnapshotNode['tier'] {
  if (resolution === 'unresolved' || confidence === 0) return 'unresolved';
  if (confidence >= 1) return 'structural';
  return 'heuristic';
}

function nodeFileOf(graph: Database, nodeId: string, kind: 'file' | 'symbol'): string | null {
  if (kind === 'file') {
    const file = graph.query('SELECT relative_path FROM g_file WHERE id = ?').get(nodeId) as { relative_path: string } | null;
    return file?.relative_path ?? null;
  }
  const file = graph.query(
    'SELECT relative_path FROM g_file WHERE id = (SELECT file_id FROM g_symbol WHERE id = ?)',
  ).get(nodeId) as { relative_path: string } | null;
  return file?.relative_path ?? null;
}

function bestEdgeTier(edges: ImpactResult['edges'], nodeId: string): SnapshotNode['tier'] {
  let best: SnapshotNode['tier'] = 'unresolved';
  for (const edge of edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    const tier = tierFor(edge.confidence, edge.resolution);
    if (tier === 'structural') return 'structural';
    if (tier === 'heuristic') best = 'heuristic';
  }
  return best;
}

export interface GraphEvidenceInput {
  seeds: string[];
  mode: 'impact' | 'why';
  direction?: 'in' | 'out' | 'both' | undefined;
  kinds?: string[] | undefined;
  maxDepth?: number | undefined;
  cap?: number | undefined;
  staleOk?: boolean | undefined;
}

// Run the graph query and freeze its answer into snapshot evidence. Refuses
// stale graphs unless stale inspection is explicit, and unknown seeds outright.
export function buildGraphEvidence(projectPath: string, input: GraphEvidenceInput): SnapshotEvidence {
  const graph = openGraph(projectPath);
  try {
    const status = graphStatus(projectPath, graph);
    assertFreshEnough(status, { allowStale: input.staleOk === true });
    const seeds: SnapshotSeed[] = [];
    const missing: string[] = [];
    for (const seed of input.seeds) {
      const matches = findSymbol(graph, seed);
      if (matches.length === 0) {
        missing.push(seed);
        continue;
      }
      seeds.push({ symbol: seed, fqn: matches[0]!.fqn, id: matches[0]!.id });
    }
    if (missing.length > 0) throw new SeedNotFoundError(missing);
    const direction = input.mode === 'why' ? 'in' : (input.direction ?? 'both');
    const kinds = input.mode === 'why' ? ['CALLS', 'REFERENCES'] : (input.kinds ?? ['CALLS', 'IMPORTS', 'INHERITS', 'INSTANTIATES', 'IMPLEMENTS', 'REFERENCES', 'CONTAINS', 'DEFINES']);
    const maxDepth = input.mode === 'why' ? 2 : (input.maxDepth ?? 2);
    const cap = input.cap ?? 500;
    const results = seeds.map((seed) =>
      input.mode === 'why'
        ? why(graph, seed.id, cap)
        : impact(graph, seed.id, { direction: direction as 'in' | 'out' | 'both', kinds, maxDepth, cap }),
    );
    const nodes = new Map<string, SnapshotNode>();
    const edges = new Map<string, ImpactResult['edges'][number]>();
    const unresolvedNames = new Set<string>();
    let truncated = false;
    const uncertainty: ImpactResult['uncertainty'] = { structural: 0, heuristic: 0, ambiguous: 0, unresolved: 0, unresolvedNames: [], candidatesTruncated: false };
    for (const result of results) {
      truncated = truncated || result.truncated;
      uncertainty.structural += result.uncertainty.structural;
      uncertainty.heuristic += result.uncertainty.heuristic;
      uncertainty.ambiguous += result.uncertainty.ambiguous;
      uncertainty.unresolved += result.uncertainty.unresolved;
      uncertainty.candidatesTruncated = uncertainty.candidatesTruncated || result.uncertainty.candidatesTruncated;
      for (const name of result.uncertainty.unresolvedNames) unresolvedNames.add(name);
      for (const node of result.nodes) {
        if (nodes.has(node.id)) continue;
        nodes.set(node.id, {
          ...node,
          file: nodeFileOf(graph, node.id, node.kind),
          tier: bestEdgeTier(result.edges, node.id),
        });
      }
      for (const edge of result.edges) edges.set(`${edge.source}\u0000${edge.target}\u0000${edge.kind}`, edge);
    }
    uncertainty.unresolvedNames = [...unresolvedNames].sort().slice(0, 50);
    const meta = readMeta(graph);
    const counts = graph
      .query('SELECT resolution, COUNT(*) AS n FROM g_edge GROUP BY resolution')
      .all() as Array<{ resolution: string; n: number }>;
    const by = new Map(counts.map((row) => [row.resolution, row.n]));
    const ambiguous = (graph.query(`SELECT COUNT(*) AS n FROM g_edge WHERE json_extract(meta, '$.ambiguous') = 1`).get() as { n: number }).n;
    return {
      envelopeVersion: GRAPH_ENVELOPE_VERSION,
      workspace: { path: projectPath, origin: gitOrigin(projectPath) },
      identity: {
        fingerprint: meta?.inputFingerprint ?? null,
        generation: meta?.generation ?? 0,
        schemaVersion: meta?.schemaVersion ?? GRAPH_SCHEMA_VERSION,
        extractorVersion: EXTRACTOR_VERSION,
        resolverVersion: RESOLUTION_VERSION,
      },
      freshness: {
        state: status.state,
        reason: status.reason ?? null,
        lastIndex: meta?.lastIndex ?? null,
        staleInspection: input.staleOk === true && status.state !== 'ready',
      },
      query: { mode: input.mode, seeds, direction: direction as 'in' | 'out' | 'both', kinds, maxDepth, cap },
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      counts: {
        nodes: (graph.query('SELECT COUNT(*) AS n FROM g_symbol').get() as { n: number }).n,
        edges: counts.reduce((sum, row) => sum + row.n, 0),
        structural: by.get('structural') ?? 0,
        heuristic: by.get('heuristic') ?? 0,
        ambiguous,
        unresolved: by.get('unresolved') ?? 0,
      },
      unresolvedNames: [...unresolvedNames].sort().slice(0, 50),
      truncated,
      uncertainty,
      fallback: { reason: null },
      sourceConfirmations: [],
    };
  } finally {
    graph.close();
  }
}

type SnapshotResult = { uncertainty: ImpactResult['uncertainty'] };

export interface FallbackEvidenceInput {
  reason: 'graph-missing' | 'graph-stale' | 'graph-incompatible' | 'graph-unavailable';
  confirmations: Array<{ path: string; confirmedBy: string; note?: string }>;
  projectPath: string;
}

// Explicit non-graph basis: records the observed graph state and the
// source-search confirmations that stand in for graph evidence.
export function buildFallbackEvidence(input: FallbackEvidenceInput): SnapshotEvidence {
  const graphPath = join(input.projectPath, '.deck', 'graph.sqlite');
  let freshness: SnapshotEvidence['freshness'] = { state: 'absent', reason: 'no graph database exists', lastIndex: null, staleInspection: false };
  let identity: SnapshotEvidence['identity'] = { fingerprint: null, generation: 0, schemaVersion: 0, extractorVersion: EXTRACTOR_VERSION, resolverVersion: RESOLUTION_VERSION };
  if (existsSync(graphPath)) {
    const graph = openGraph(input.projectPath);
    try {
      const status = graphStatus(input.projectPath, graph);
      const meta = readMeta(graph);
      freshness = { state: status.state, reason: status.reason ?? null, lastIndex: meta?.lastIndex ?? null, staleInspection: false };
      identity = {
        fingerprint: meta?.inputFingerprint ?? null,
        generation: meta?.generation ?? 0,
        schemaVersion: meta?.schemaVersion ?? 0,
        extractorVersion: EXTRACTOR_VERSION,
        resolverVersion: RESOLUTION_VERSION,
      };
    } finally {
      graph.close();
    }
  }
  return {
    envelopeVersion: GRAPH_ENVELOPE_VERSION,
    workspace: { path: input.projectPath, origin: gitOrigin(input.projectPath) },
    identity,
    freshness,
    query: { mode: 'impact', seeds: [], direction: 'both', kinds: [], maxDepth: 0, cap: 0 },
    nodes: [],
    edges: [],
    counts: { nodes: 0, edges: 0, structural: 0, heuristic: 0, ambiguous: 0, unresolved: 0 },
    unresolvedNames: [],
    truncated: false,
    uncertainty: { structural: 0, heuristic: 0, ambiguous: 0, unresolved: 0, unresolvedNames: [], candidatesTruncated: false },
    fallback: { reason: input.reason },
    sourceConfirmations: input.confirmations.map((confirmation) => ({
      path: confirmation.path,
      confirmedBy: confirmation.confirmedBy,
      note: confirmation.note ?? '',
    })),
  };
}

export function evidenceCarriesUncertainty(evidence: SnapshotEvidence): boolean {
  const { uncertainty, truncated } = evidence;
  return (
    evidence.fallback.reason !== null ||
    evidence.nodes.some((node) => node.tier !== 'structural') ||
    evidence.edges.some((edge) => edge.resolution !== 'structural') ||
    uncertainty.heuristic > 0 ||
    uncertainty.ambiguous > 0 ||
    uncertainty.unresolved > 0 ||
    uncertainty.unresolvedNames.length > 0 ||
    uncertainty.candidatesTruncated ||
    truncated ||
    evidence.freshness.staleInspection ||
    evidence.freshness.state !== 'ready'
  );
}

export interface ApproveInput {
  cardId: string;
  snapshotId: string;
  actor: string;
  rationale: string;
  acknowledgedUncertainty?: string | undefined;
  fallbackAcknowledged?: boolean | undefined;
}

// Explicit, revision-checked acceptance. Refuses stale basis, cross-card
// snapshots, and attempts to approve uncertain or fallback evidence without
// acknowledging exactly that uncertainty.
export function approveImpactSnapshot(db: SQLiteBunDatabase, input: ApproveInput): ImpactApprovalRecord {
  const row = db.select().from(impactSnapshots).where(eq(impactSnapshots.id, input.snapshotId)).get();
  if (row === undefined) throw new SnapshotNotFoundError(input.cardId, input.snapshotId);
  if (row.cardId !== input.cardId) throw new CrossCardSnapshotError(input.cardId, input.snapshotId, row.cardId);
  const snapshot = decodeSnapshot(row);
  const current = currentScopeRevision(db, input.cardId);
  if (snapshot.basisRevision !== current) {
    throw new StaleApprovalBasisError(input.cardId, snapshot.basisRevision, current, acceptedRevision(db, input.cardId)?.revisionId ?? null);
  }
  if (evidenceCarriesUncertainty(snapshot.evidence) && (input.acknowledgedUncertainty ?? '').trim().length === 0) {
    throw new UncertaintyAcknowledgementError(input.cardId, input.snapshotId);
  }
  if (snapshot.mode === 'fallback' && input.fallbackAcknowledged !== true) {
    throw new FallbackAcknowledgementError(input.cardId, input.snapshotId);
  }
  const existing = db
    .select()
    .from(impactApprovals)
    .where(and(eq(impactApprovals.cardId, input.cardId), eq(impactApprovals.snapshotId, input.snapshotId), eq(impactApprovals.revision, current)))
    .get();
  if (existing !== undefined) return decodeApproval(existing);
  const revisionRow = acceptedRevision(db, input.cardId, current)!;
  const id = `ia-${createHash('sha256').update(`${input.cardId}\n${input.snapshotId}\n${current}\n${input.actor}`).digest('hex').slice(0, 12)}`;
  const record: ImpactApprovalRecord = {
    id,
    cardId: input.cardId,
    snapshotId: input.snapshotId,
    revision: current,
    revisionId: revisionRow.revisionId,
    actor: input.actor,
    rationale: input.rationale,
    acknowledgedUncertainty: (input.acknowledgedUncertainty ?? '').trim(),
    fallbackAcknowledged: input.fallbackAcknowledged === true,
    approvedAt: new Date().toISOString(),
  };
  db.insert(impactApprovals)
    .values({
      id: record.id,
      cardId: record.cardId,
      snapshotId: record.snapshotId,
      revision: record.revision,
      revisionId: record.revisionId,
      actor: record.actor,
      rationale: record.rationale,
      acknowledgedUncertainty: record.acknowledgedUncertainty,
      fallbackAcknowledged: record.fallbackAcknowledged,
      approvedAt: record.approvedAt,
    })
    .onConflictDoNothing()
    .run();
  return record;
}

export function listImpactSnapshots(db: SQLiteBunDatabase, cardId: string): ImpactSnapshotRecord[] {
  return db
    .select()
    .from(impactSnapshots)
    .where(eq(impactSnapshots.cardId, cardId))
    .orderBy(desc(impactSnapshots.capturedAt))
    .all()
    .map(decodeSnapshot);
}

export function listApprovals(db: SQLiteBunDatabase, cardId: string): ImpactApprovalRecord[] {
  return db
    .select()
    .from(impactApprovals)
    .where(eq(impactApprovals.cardId, cardId))
    .orderBy(desc(impactApprovals.approvedAt))
    .all()
    .map(decodeApproval);
}

export function showImpactSnapshot(db: SQLiteBunDatabase, cardId: string, snapshotId?: string): ImpactSnapshotRecord | null {
  if (snapshotId !== undefined) {
    const row = db
      .select()
      .from(impactSnapshots)
      .where(and(eq(impactSnapshots.cardId, cardId), eq(impactSnapshots.id, snapshotId)))
      .get();
    if (row === undefined) throw new SnapshotNotFoundError(cardId, snapshotId);
    return decodeSnapshot(row);
  }
  const row = db
    .select()
    .from(impactSnapshots)
    .where(eq(impactSnapshots.cardId, cardId))
    .orderBy(desc(impactSnapshots.capturedAt))
    .get();
  return row === undefined ? null : decodeSnapshot(row);
}

// The approval standing for the card's current accepted revision, if any.
// Scope edits advance the revision and leave historical approvals behind.
export function currentApprovedImpact(
  db: SQLiteBunDatabase,
  cardId: string,
): { snapshot: ImpactSnapshotRecord; approval: ImpactApprovalRecord } | null {
  const current = currentScopeRevision(db, cardId);
  if (current === 0) return null;
  const approvals = db
    .select()
    .from(impactApprovals)
    .where(and(eq(impactApprovals.cardId, cardId), eq(impactApprovals.revision, current)))
    .orderBy(desc(impactApprovals.approvedAt))
    .all();
  for (const row of approvals) {
    const snapshotRow = db.select().from(impactSnapshots).where(eq(impactSnapshots.id, row.snapshotId)).get();
    if (snapshotRow === undefined) continue;
    return { snapshot: decodeSnapshot(snapshotRow), approval: decodeApproval(row) };
  }
  return null;
}

export type ImpactBasisClassification = 'approved-graph' | 'approved-fallback' | 'captured-unapproved' | 'missing';

export interface ImpactBasisView {
  cardId: string;
  revision: number;
  classification: ImpactBasisClassification;
  snapshot: ImpactSnapshotRecord | null;
  approval: ImpactApprovalRecord | null;
  capturedCount: number;
}

// One read model for every graph-backed-claim decision: digests, review, CLI.
export function impactBasisView(db: SQLiteBunDatabase, cardId: string): ImpactBasisView {
  const revision = currentScopeRevision(db, cardId);
  const approved = currentApprovedImpact(db, cardId);
  if (approved !== null) {
    return {
      cardId,
      revision,
      classification: approved.snapshot.mode === 'fallback' ? 'approved-fallback' : 'approved-graph',
      snapshot: approved.snapshot,
      approval: approved.approval,
      capturedCount: listImpactSnapshots(db, cardId).length,
    };
  }
  const captured = listImpactSnapshots(db, cardId);
  const currentCapture = captured.find((snapshot) => snapshot.basisRevision === revision);
  return {
    cardId,
    revision,
    classification: currentCapture !== undefined ? 'captured-unapproved' : 'missing',
    snapshot: currentCapture ?? null,
    approval: null,
    capturedCount: captured.length,
  };
}

const HIGH_RISK_FAN_IN = 5;

export interface ImpactDriftReport {
  cardId: string;
  basis: ImpactBasisClassification;
  snapshotId: string | null;
  revision: number;
  unexpectedFiles: string[];
  untouchedHighRisk: Array<{ file: string; symbol: string; fanIn: number | null; tier: SnapshotNode['tier'] }>;
  uncertaintyLabel: string | null;
}

// Actual-versus-planned comparison at file granularity (git supplies files,
// not symbols). High-risk expectations keep their resolution tier so heuristic
// mismatches read as uncertainty, not violations.
export function impactDrift(db: SQLiteBunDatabase, cardId: string, changedFiles: string[]): ImpactDriftReport {
  const basis = impactBasisView(db, cardId);
  const report: ImpactDriftReport = {
    cardId,
    basis: basis.classification,
    snapshotId: basis.snapshot?.id ?? null,
    revision: basis.revision,
    unexpectedFiles: [],
    untouchedHighRisk: [],
    uncertaintyLabel: null,
  };
  if (basis.snapshot === null || basis.approval === null) return report;
  const snapshotFiles = new Set(
    basis.snapshot.evidence.nodes
      .map((node) => node.file ?? (node.kind === 'file' ? node.detail : null))
      .filter((file): file is string => file !== null),
  );
  report.unexpectedFiles = changedFiles.filter((file) => !snapshotFiles.has(file));
  const changed = new Set(changedFiles);
  report.untouchedHighRisk = basis.snapshot.evidence.nodes
    .filter((node) => node.kind === 'symbol' && node.file !== null && !changed.has(node.file) && (node.fanIn ?? 0) >= HIGH_RISK_FAN_IN)
    .slice(0, 10)
    .map((node) => ({ file: node.file!, symbol: node.name, fanIn: node.fanIn, tier: node.tier }));
  const { uncertainty, truncated } = basis.snapshot.evidence;
  if (uncertainty.heuristic > 0 || uncertainty.ambiguous > 0 || uncertainty.unresolved > 0 || truncated) {
    report.uncertaintyLabel = `snapshot carries uncertainty (heuristic ${uncertainty.heuristic} · ambiguous ${uncertainty.ambiguous} · unresolved ${uncertainty.unresolved}${truncated ? ' · truncated' : ''})`;
  }
  return report;
}

export { StaleGraphError };

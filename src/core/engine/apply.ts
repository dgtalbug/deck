import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DeckError } from '../board/errors.ts';
import { acceptedRevision, currentScopeRevision, currentAcceptedSnapshot, acceptedContentDigest } from '../board/accepted-scope.ts';
import { impactBasisView } from '../board/impact-snapshots.ts';
import {
  applyOperations,
  cards,
  checkpointRecords,
  completionRecords,
  evidenceRunLinks,
  evidenceRuns,
  storyDeps,
} from '../board/schema.ts';
import { runTx, type DocumentStore } from '../board/store.ts';
import { readCheckpoint, writeCheckpoint, checkpointBasis, sourceDigest, CHECKPOINT_KINDS, MAX_CHECKPOINT_TEXT, type CheckpointKind } from '../board/checkpoint.ts';
import { readFileSync } from 'node:fs';
import { reserveOperation, compensateOperation, type Operation } from './ownership.ts';
import { getPolicy } from '../board/rules.ts';
import { scopeCriteria } from '../board/accepted-scope.ts';
import { captureExecutionInputs } from './evidence-inputs.ts';
import { evaluateEligibility } from './evidence.ts';
import { runGit } from '../git/digest.ts';
import { listUnsettledOperations } from './ownership.ts';

export type ImpactBasisClassification = 'approved-graph' | 'approved-fallback' | 'captured-unapproved' | 'missing';
export type ApplyState = 'active' | 'cancelled' | 'completed';
export type DirtyPolicy = 'allow' | 'refuse';

export interface ApplyBasis {
  id: string;
  cardId: string;
  acceptedRevision: number;
  revisionId: string;
  planDigest: string;
  impactBasis: ImpactBasisClassification;
  impactSnapshotId: string | null;
  owner: string;
  checkout: string;
  branch: string | null;
  headSha: string | null;
  dirtyPolicy: DirtyPolicy;
  dependenciesReady: boolean;
  dependencyReport: string;
  state: ApplyState;
  createdAt: string;
  updatedAt: string;
}

type ApplyRow = typeof applyOperations.$inferSelect;

function toBasis(row: ApplyRow): ApplyBasis {
  return { ...row };
}

export class MissingAcceptedBasisError extends DeckError {
  constructor(cardId: string) {
    super(
      `card ${cardId} has no accepted specification revision — controlled apply binds to accepted scope; groom or accept the scope first`,
      { cardId },
    );
  }
}

export class StaleApplyBasisError extends DeckError {
  constructor(cardId: string, basisRevision: number, currentRevision: number) {
    super(
      `apply basis of ${cardId} is stale — prepared at revision ${basisRevision}, current is ${currentRevision}; ` +
        `cancel or refresh the apply operation before mutating execution state`,
      { cardId, basisRevision, currentRevision },
    );
  }
}

export class EvidenceRunPayloadConflictError extends DeckError {
  constructor(runId: string) {
    super(
      `evidence run '${runId}' already exists with a different payload — run identity cannot be reused for changed evidence; use a new run`,
      { runId },
    );
  }
}

export class IncompleteEvidenceRunError extends DeckError {
  constructor(runId: string) {
    super(`evidence run '${runId}' is incomplete — its evidence is visible but ineligible for completion`, { runId });
  }
}

export class CompletionBlockedError extends DeckError {
  readonly blockers: string[];
  constructor(cardId: string, blockers: string[]) {
    super(
      `completion of ${cardId} is blocked — ${blockers.length} invariant failure(s): ${blockers.join('; ')}`,
      { cardId, blockers },
    );
    this.blockers = blockers;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Dependency readiness: a card is blocked while any dependency edge points at
// a card that is not done.
function dependencyReadiness(store: DocumentStore, cardId: string): { ready: boolean; report: string } {
  const rows = store.db
    .select()
    .from(storyDeps)
    .where(eq(storyDeps.cardId, cardId))
    .all();
  const pending: string[] = [];
  for (const row of rows) {
    const dep = store.db.select({ lane: cards.lane }).from(cards).where(eq(cards.id, row.dependsOn)).get();
    if (dep === undefined || dep.lane !== 'done') pending.push(row.dependsOn);
  }
  return { ready: pending.length === 0, report: JSON.stringify({ dependencies: rows.map((row) => row.dependsOn), pending }) };
}

export interface StartApplyInput {
  owner?: string | undefined;
  dirtyPolicy?: DirtyPolicy | undefined;
}

// One controlled apply per accepted basis. Reserves the ownership operation
// first (fencing, lease, checkout conflicts) and records the execution basis
// before any execution state mutates.
export async function startApply(store: DocumentStore, cardId: string, input: StartApplyInput = {}): Promise<{ operation: Operation; basis: ApplyBasis }> {
  const revision = currentScopeRevision(store.db, cardId);
  const snapshot = currentAcceptedSnapshot(store.db, cardId);
  const revisionRow = acceptedRevision(store.db, cardId);
  if (revision === 0 || snapshot === null || revisionRow === null) {
    throw new MissingAcceptedBasisError(cardId);
  }
  const active = currentApply(store, cardId);
  if (active !== null) {
    throw new DeckError(
      `card ${cardId} already has active apply operation ${active.id} (revision ${active.acceptedRevision}) — resume or cancel it first`,
      { cardId, operationId: active.id },
    );
  }
  const operation = reserveOperation(store, cardId, 'apply');
  const impact = impactBasisView(store.db, cardId);
  const checkout = operation.checkout;
  const branch = (await runGit(checkout, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)).stdout.trim() || null;
  const headSha = (await runGit(checkout, ['rev-parse', 'HEAD'], 5000)).stdout.trim() || null;
  const status = (await runGit(checkout, ['status', '--porcelain'], 5000)).stdout;
  const dirty = status.trim().length > 0;
  if (dirty && (input.dirtyPolicy ?? 'refuse') === 'refuse') {
    compensateOperation(store, operation.id);
    throw new DeckError(
      `checkout ${checkout} is dirty and the apply input policy refuses dirty checkouts — commit or stash first, or start with dirty policy 'allow'`,
      { cardId, operationId: operation.id, dirtyPolicy: 'refuse' },
    );
  }
  const deps = dependencyReadiness(store, cardId);
  const ts = nowIso();
  const basis: ApplyBasis = {
    id: operation.id,
    cardId,
    acceptedRevision: revision,
    revisionId: revisionRow.revisionId,
    planDigest: acceptedContentDigest(snapshot),
    impactBasis: impact.classification,
    impactSnapshotId: impact.snapshot?.id ?? null,
    owner: input.owner ?? 'controlled-apply',
    checkout,
    branch,
    headSha,
    dirtyPolicy: input.dirtyPolicy ?? 'refuse',
    dependenciesReady: deps.ready,
    dependencyReport: deps.report,
    state: 'active',
    createdAt: ts,
    updatedAt: ts,
  };
  runTx(store.db, (tx) => {
    tx.insert(applyOperations).values({ ...basis }).run();
  });
  return { operation, basis };
}

export function currentApply(store: DocumentStore, cardId: string): ApplyBasis | null {
  const row = store.db
    .select()
    .from(applyOperations)
    .where(and(eq(applyOperations.cardId, cardId), eq(applyOperations.state, 'active')))
    .orderBy(desc(applyOperations.createdAt))
    .get();
  return row === undefined ? null : toBasis(row);
}

export function getApply(store: DocumentStore, operationId: string): ApplyBasis | null {
  const row = store.db.select().from(applyOperations).where(eq(applyOperations.id, operationId)).get();
  return row === undefined ? null : toBasis(row);
}

function assertBasisCurrent(store: DocumentStore, basis: ApplyBasis): void {
  const current = currentScopeRevision(store.db, basis.cardId);
  if (basis.acceptedRevision !== current) {
    throw new StaleApplyBasisError(basis.cardId, basis.acceptedRevision, current);
  }
  const snapshot = currentAcceptedSnapshot(store.db, basis.cardId);
  if (snapshot === null || acceptedContentDigest(snapshot) !== basis.planDigest) {
    throw new StaleApplyBasisError(basis.cardId, basis.acceptedRevision, current);
  }
}

export interface ApplyStatusView {
  operation: ApplyBasis | null;
  basis: 'current' | 'stale' | 'none';
  currentRevision: number;
  checkpoint: { revision: number; pendingProjection: number } | null;
  remainingTasks: Array<{ id: string; title: string }>;
  evidenceBlockers: string[];
  recovery: string[];
}

export async function applyStatus(store: DocumentStore, cardId: string): Promise<ApplyStatusView> {
  store.getCard(cardId); // typed not-found refusal for unknown cards
  const basis = currentApply(store, cardId);
  const currentRevision = currentScopeRevision(store.db, cardId);
  if (basis === null) {
    const evaluation = await evaluateEligibility(store, cardId);
    return {
      operation: null,
      basis: 'none',
      currentRevision,
      checkpoint: null,
      remainingTasks: [],
      evidenceBlockers: evaluation.reasons,
      recovery: ['deck apply start <id> to begin a controlled apply'],
    };
  }
  let basisState: 'current' | 'stale' = 'current';
  try {
    assertBasisCurrent(store, basis);
  } catch {
    basisState = 'stale';
  }
  const card = store.getVerbItem(cardId);
  const remaining = card.tasks.filter((task) => !task.done).map((task) => ({ id: task.id, title: task.title }));
  const evaluation = await evaluateEligibility(store, cardId);
  const recovery = basisState === 'stale'
    ? ['deck apply cancel <id> then start a fresh apply against the current revision']
    : ['deck apply resume <id>', 'deck apply cancel <id>'];
  return {
    operation: basis,
    basis: basisState,
    currentRevision,
    checkpoint: durableCheckpointSummary(store, cardId),
    remainingTasks: remaining,
    evidenceBlockers: evaluation.reasons,
    recovery,
  };
}

// Resume returns the same operation identity with the remaining work and never
// duplicates effects; a stale basis refuses until refreshed.
export async function resumeApply(store: DocumentStore, cardId: string): Promise<ApplyStatusView> {
  const view = await applyStatus(store, cardId);
  if (view.operation === null) {
    throw new DeckError(`card ${cardId} has no active apply operation to resume — start one first`, { cardId });
  }
  if (view.basis === 'stale') {
    throw new StaleApplyBasisError(cardId, view.operation.acceptedRevision, view.currentRevision);
  }
  return view;
}

// Cancellation compensates the ownership operation, marks the basis terminal,
// and touches nothing else: unrelated files, other operations and history stay.
export function cancelApply(store: DocumentStore, cardId: string): ApplyBasis {
  const basis = currentApply(store, cardId);
  if (basis === null) {
    throw new DeckError(`card ${cardId} has no active apply operation to cancel`, { cardId });
  }
  const row = store.db.select().from(applyOperations).where(eq(applyOperations.id, basis.id)).get();
  if (row !== undefined) {
    runTx(store.db, (tx) => {
      tx.update(applyOperations)
        .set({ state: 'cancelled', updatedAt: nowIso() })
        .where(and(eq(applyOperations.id, basis.id), eq(applyOperations.state, 'active')))
        .run();
    });
  }
  try {
    compensateOperation(store, basis.id);
  } catch {
    // The ownership row may already be compensated or owned elsewhere after
    // recovery; the basis row above is the apply authority for this call.
  }
  return { ...basis, state: 'cancelled', updatedAt: nowIso() };
}

// --- Durable checkpoints -------------------------------------------------

export interface DurableCheckpoint {
  id: string;
  cardId: string;
  applyOperation: string | null;
  scopeRevision: number;
  checkpointRevision: number;
  digest: string;
  actor: string;
  kind: CheckpointKind;
  text: string;
  projection: 'projected' | 'pending' | 'unknown';
  createdAt: string;
}

export function durableCheckpointSummary(store: DocumentStore, cardId: string): { revision: number; pendingProjection: number } | null {
  const rows = listDurableCheckpoints(store, cardId);
  if (rows.length === 0) return null;
  const projected = rows.filter((row) => row.projection === 'projected');
  const maxRevision = Math.max(...rows.map((row) => row.checkpointRevision));
  return { revision: maxRevision, pendingProjection: rows.filter((row) => row.projection === 'pending').length + (projected.length < rows.length ? 0 : 0) };
}

export function listDurableCheckpoints(store: DocumentStore, cardId: string): DurableCheckpoint[] {
  return store.db
    .select()
    .from(checkpointRecords)
    .where(eq(checkpointRecords.cardId, cardId))
    .orderBy(desc(checkpointRecords.checkpointRevision))
    .all() as DurableCheckpoint[];
}

export interface RecordCheckpointInput {
  cardId: string;
  kind: CheckpointKind;
  text: string;
  actor: string;
  applyOperation?: string | undefined;
  project?: boolean | undefined;
}

// Database first: the durable row commits authority, then the Markdown file is
// projected. A crash between the two leaves the row readable with a pending
// projection instead of losing the checkpoint.
export function recordCheckpoint(store: DocumentStore, input: RecordCheckpointInput): DurableCheckpoint {
  const text = input.text.trim();
  if (text.length === 0) throw new DeckError('checkpoint text is empty', { cardId: input.cardId });
  if (text.length > MAX_CHECKPOINT_TEXT) {
    throw new DeckError(`checkpoint text exceeds ${MAX_CHECKPOINT_TEXT} code units`, { cardId: input.cardId });
  }
  if (!CHECKPOINT_KINDS.includes(input.kind)) {
    throw new DeckError(`kind '${input.kind}' is not one of ${CHECKPOINT_KINDS.join('|')}`, { cardId: input.cardId });
  }
  const scopeRevision = currentScopeRevision(store.db, input.cardId);
  const previous = listDurableCheckpoints(store, input.cardId);
  const checkpointRevision = (previous[0]?.checkpointRevision ?? 0) + 1;
  const id = `cr-${sha256(`${input.cardId}\n${checkpointRevision}\n${text}`).slice(0, 12)}`;
  const digest = sha256(`${input.kind}\n${input.actor}\n${text}`);
  const record: DurableCheckpoint = {
    id,
    cardId: input.cardId,
    applyOperation: input.applyOperation ?? currentApply(store, input.cardId)?.id ?? null,
    scopeRevision,
    checkpointRevision,
    digest,
    actor: input.actor,
    kind: input.kind,
    text,
    projection: 'pending',
    createdAt: nowIso(),
  };
  runTx(store.db, (tx) => {
    tx.insert(checkpointRecords).values(record).onConflictDoNothing().run();
  });
  if (input.project !== false) {
    projectCheckpoint(store, record);
  }
  return record;
}

// Idempotent Markdown projection of durable state: re-projecting an already
// projected revision is a no-op, and a failed projection leaves 'pending'.
// The projected basis matches the digest builder's provenance form
// (scope revision + rendered-spec source digest) so checkpoint freshness
// reads consistently across doors.
export function projectCheckpoint(store: DocumentStore, record: DurableCheckpoint): void {
  const card = store.getCard(record.cardId);
  const specRelative = card !== null && 'specPath' in card ? join(card.specPath, 'spec.md') : null;
  const specPath = specRelative !== null ? join(store.projectPath, specRelative) : null;
  const sourceRevision = specPath !== null && existsSync(specPath) ? sourceDigest(readFileSync(specPath, 'utf8')) : undefined;
  const basis = checkpointBasis(record.scopeRevision, sourceRevision);
  writeCheckpoint(store.projectPath, record.cardId, { text: record.text, kind: record.kind, basis, id: record.id });
  runTx(store.db, (tx) => {
    tx.update(checkpointRecords).set({ projection: 'projected' }).where(eq(checkpointRecords.id, record.id)).run();
  });
}

// A Markdown file with no matching durable row is an untrusted projection:
// legacy content imports as unknown provenance and never gains authority.
export function importCheckpointFile(store: DocumentStore, cardId: string): { imported: number; unknown: boolean } {
  const path = join(store.projectPath, '.deck', 'sessions', `${cardId}.md`);
  const state = readCheckpoint(store.projectPath, cardId);
  if (!state.managed) return { imported: 0, unknown: existsSync(path) };
  const known = new Set(listDurableCheckpoints(store, cardId).map((row) => row.id));
  const scopeRevision = currentScopeRevision(store.db, cardId);
  let imported = 0;
  let malformed = state.entries.some((entry) => entry.basis === 'unknown');
  for (const entry of state.entries) {
    if (known.has(entry.id)) continue;
    if (!/^scope:\d+:[0-9a-f]{16}$/.test(entry.basis) && entry.basis !== 'unknown') malformed = true;
    const checkpointRevision = (listDurableCheckpoints(store, cardId)[0]?.checkpointRevision ?? 0) + 1;
    const record: DurableCheckpoint = {
      id: entry.id,
      cardId,
      applyOperation: null,
      scopeRevision,
      checkpointRevision,
      digest: sha256(entry.text),
      actor: 'legacy-import',
      kind: entry.kind,
      text: entry.text,
      projection: 'unknown',
      createdAt: nowIso(),
    };
    runTx(store.db, (tx) => {
      tx.insert(checkpointRecords).values(record).onConflictDoNothing().run();
    });
    imported += 1;
  }
  return { imported, unknown: malformed };
}

// --- Evidence runs ---------------------------------------------------------

export interface EvidenceRunLink {
  criterionId: string | null;
  taskId: string | null;
}

export interface EvidenceRun {
  id: string;
  cardId: string;
  scopeRevision: number;
  policyVersion: number;
  applyOperation: string | null;
  inputFingerprint: string;
  producer: string;
  checkType: 'machine' | 'manual';
  checkId: string | null;
  result: 'passed' | 'failed' | 'unavailable';
  payloadDigest: string;
  artifacts: string;
  state: 'complete' | 'incomplete';
  createdAt: string;
  links: EvidenceRunLink[];
}

export interface BeginEvidenceRunInput {
  cardId: string;
  producer: string;
  checkType: 'machine' | 'manual';
  checkId?: string | undefined;
  inputFingerprint: string;
  policyVersion: number;
  applyOperation?: string | undefined;
  runId?: string | undefined;
}

function runPayloadDigest(input: BeginEvidenceRunInput, result: string, links: EvidenceRunLink[]): string {
  return sha256(JSON.stringify({
    cardId: input.cardId,
    producer: input.producer,
    checkType: input.checkType,
    checkId: input.checkId ?? null,
    inputFingerprint: input.inputFingerprint,
    policyVersion: input.policyVersion,
    result,
    links: [...links].sort((a, b) => `${a.criterionId}/${a.taskId}`.localeCompare(`${b.criterionId}/${b.taskId}`)),
  }));
}

function decodeRun(row: typeof evidenceRuns.$inferSelect, links: EvidenceRunLink[]): EvidenceRun {
  return { ...row, links };
}

// Begins a run: visible immediately, ineligible for completion until finalized.
export function beginEvidenceRun(store: DocumentStore, input: BeginEvidenceRunInput): EvidenceRun {
  const id = input.runId ?? `er-${randomUUID()}`;
  const links: EvidenceRunLink[] = [];
  const payloadDigest = runPayloadDigest(input, 'pending', links);
  const scopeRevision = currentScopeRevision(store.db, input.cardId);
  const ts = nowIso();
  const row = {
    id,
    cardId: input.cardId,
    scopeRevision,
    policyVersion: input.policyVersion,
    applyOperation: input.applyOperation ?? currentApply(store, input.cardId)?.id ?? null,
    inputFingerprint: input.inputFingerprint,
    producer: input.producer,
    checkType: input.checkType,
    checkId: input.checkId ?? null,
    result: 'unavailable' as const,
    payloadDigest,
    artifacts: '[]',
    state: 'incomplete' as const,
    createdAt: ts,
  };
  runTx(store.db, (tx) => {
    tx.insert(evidenceRuns).values(row).onConflictDoNothing().run();
  });
  return decodeRun(row, links);
}

export interface CompleteEvidenceRunInput {
  runId: string;
  result: 'passed' | 'failed' | 'unavailable';
  criteria?: string[] | undefined;
  taskIds?: string[] | undefined;
  artifacts?: Array<{ path: string; sha256: string; bytes: number }> | undefined;
}

// Finalizes a run and every criterion/task link in one transaction: either the
// run and all links commit together or none become eligible for completion.
// Retrying the same payload returns the original; a changed payload under the
// same identity refuses.
export function completeEvidenceRun(store: DocumentStore, input: CompleteEvidenceRunInput): EvidenceRun {
  const row = store.db.select().from(evidenceRuns).where(eq(evidenceRuns.id, input.runId)).get();
  if (row === undefined) {
    throw new DeckError(`evidence run '${input.runId}' not found — begin the run before completing it`, { runId: input.runId });
  }
  const links: EvidenceRunLink[] = [
    ...(input.criteria ?? []).map((criterionId): EvidenceRunLink => ({ criterionId, taskId: null })),
    ...(input.taskIds ?? []).map((taskId): EvidenceRunLink => ({ criterionId: null, taskId })),
  ];
  const payloadDigest = runPayloadDigest(
    {
      cardId: row.cardId,
      producer: row.producer,
      checkType: row.checkType,
      checkId: row.checkId ?? undefined,
      inputFingerprint: row.inputFingerprint,
      policyVersion: row.policyVersion,
    },
    input.result,
    links,
  );
  const existing = store.db
    .select()
    .from(evidenceRuns)
    .where(and(eq(evidenceRuns.cardId, row.cardId), eq(evidenceRuns.payloadDigest, payloadDigest)))
    .get();
  if (existing !== undefined && existing.id !== input.runId) {
    // Identical payload already recorded under another run id: return it
    // instead of duplicating links.
    return decodeRun(existing, linksOf(store, existing.id));
  }
  if (row.state === 'complete') {
    if (row.payloadDigest !== payloadDigest) throw new EvidenceRunPayloadConflictError(input.runId);
    return decodeRun(row, linksOf(store, row.id));
  }
  const ts = nowIso();
  runTx(store.db, (tx) => {
    tx.update(evidenceRuns)
      .set({ result: input.result, payloadDigest, state: 'complete', artifacts: JSON.stringify(input.artifacts ?? []) })
      .where(and(eq(evidenceRuns.id, input.runId), eq(evidenceRuns.state, 'incomplete')))
      .run();
    for (const link of links) {
      tx.insert(evidenceRunLinks).values({ runId: input.runId, criterionId: link.criterionId, taskId: link.taskId }).onConflictDoNothing().run();
    }
    void ts;
  });
  const updated = store.db.select().from(evidenceRuns).where(eq(evidenceRuns.id, input.runId)).get()!;
  return decodeRun(updated, linksOf(store, updated.id));
}

function linksOf(store: DocumentStore, runId: string): EvidenceRunLink[] {
  return store.db
    .select()
    .from(evidenceRunLinks)
    .where(eq(evidenceRunLinks.runId, runId))
    .all()
    .map((row) => ({ criterionId: row.criterionId, taskId: row.taskId }));
}

export function listEvidenceRuns(store: DocumentStore, cardId: string): EvidenceRun[] {
  return store.db
    .select()
    .from(evidenceRuns)
    .where(eq(evidenceRuns.cardId, cardId))
    .orderBy(desc(evidenceRuns.createdAt))
    .all()
    .map((row) => decodeRun(row, linksOf(store, row.id)));
}

// Digest over the evidence runs that a handoff offer saw, so acceptance can
// refuse when the evidence basis moved underneath the offer.
export function evidenceBasisDigest(store: DocumentStore, cardId: string): string {
  const revision = currentScopeRevision(store.db, cardId);
  const runs = listEvidenceRuns(store, cardId).filter((run) => run.scopeRevision === revision);
  return sha256(JSON.stringify(runs.map((run) => [run.id, run.state, run.result])));
}

// --- Completion invariant --------------------------------------------------

export interface CompletionInvariant {
  satisfied: boolean;
  blockers: string[];
  acceptedRevision: number;
  inputFingerprint: string | null;
  criteria: Array<{ criterionId: string; title: string; status: string; runId: string | null }>;
  incompleteRuns: string[];
  uncertainty: string[];
}

// One invariant across every completion route: accepted criteria satisfied by
// current evidence runs, task progress complete, review/delivery policy
// enrolled, and evidence bound to the current source fingerprint. Done lanes,
// checked checkboxes, provider state or stale evidence never substitute.
export async function completionInvariant(store: DocumentStore, cardId: string): Promise<CompletionInvariant> {
  const blockers: string[] = [];
  const uncertainty: string[] = [];
  const acceptedRevision = currentScopeRevision(store.db, cardId);
  if (acceptedRevision === 0) {
    return {
      satisfied: false,
      blockers: ['card has no accepted specification revision'],
      acceptedRevision: 0,
      inputFingerprint: null,
      criteria: [],
      incompleteRuns: [],
      uncertainty,
    };
  }
  const policy = getPolicy(store, cardId);
  if (policy === undefined) {
    blockers.push('no enrolled delivery/evidence policy — enroll explicitly before completion');
  }
  const evaluation = await evaluateEligibility(store, cardId);
  const fingerprint = evaluation.fingerprint;
  const runs = listEvidenceRuns(store, cardId);
  const currentRuns = runs.filter(
    (run) => run.scopeRevision === acceptedRevision && (policy === undefined || run.policyVersion === policy.version) && run.inputFingerprint === fingerprint,
  );
  const incompleteRuns = currentRuns.filter((run) => run.state === 'incomplete').map((run) => run.id);
  if (incompleteRuns.length > 0) {
    blockers.push(`incomplete evidence run(s) ${incompleteRuns.join(', ')} are ineligible for completion`);
  }
  const runByCriterion = new Map<string, string>();
  for (const run of currentRuns) {
    if (run.state !== 'complete' || run.result !== 'passed') continue;
    for (const link of run.links) {
      if (link.criterionId !== null && !runByCriterion.has(link.criterionId)) runByCriterion.set(link.criterionId, run.id);
    }
  }
  const criteria = scopeCriteria(store.db, cardId)
    .filter((criterion) => criterion.state === 'active')
    .map((criterion) => {
      const evaluated = evaluation.criteria.find((item) => item.criterionId === criterion.id)?.status ?? 'missing';
      // Criterion satisfaction comes from current evidence runs when present,
      // otherwise from the legacy per-criterion records (qualified as
      // legacy-unbatched); neither lanes nor stale records substitute.
      const runId = runByCriterion.get(criterion.id) ?? null;
      const status = evaluated === 'satisfied' || runId !== null ? 'satisfied' : evaluated;
      if (status !== 'satisfied') {
        blockers.push(`criterion "${criterion.title}" (${criterion.id}): ${status}`);
      }
      return { criterionId: criterion.id, title: criterion.title, status, runId: runId ?? (evaluation.criteria.find((item) => item.criterionId === criterion.id)?.recordId ?? null) };
    });
  if (evaluation.enrolled && !evaluation.eligible && criteria.some((criterion) => criterion.status !== 'satisfied')) {
    // Legacy-record gaps that current evidence runs do not cover remain
    // blockers; the merged per-criterion statuses above carry the detail.
    blockers.push('criterion evidence is not current across every accepted criterion');
  }
  const card = store.getVerbItem(cardId);
  const unfinished = card.tasks.filter((task) => !task.done);
  if (unfinished.length > 0) {
    blockers.push(`unchecked task(s): ${unfinished.map((task) => `"${task.title}"`).join(', ')}`);
  }
  const impact = impactBasisView(store.db, cardId);
  if (impact.classification === 'missing') {
    uncertainty.push('no approved impact snapshot — blast radius is not graph-backed');
  } else if (impact.classification === 'approved-fallback') {
    uncertainty.push('impact basis is an approved source-search fallback, not graph evidence');
  } else if (impact.classification === 'captured-unapproved') {
    uncertainty.push(`impact snapshot ${impact.snapshot?.id ?? 'unknown'} captured but not approved`);
  }
  return {
    satisfied: blockers.length === 0,
    blockers,
    acceptedRevision,
    inputFingerprint: fingerprint,
    criteria,
    incompleteRuns,
    uncertainty,
  };
}

export interface CompletionRecord {
  id: string;
  cardId: string;
  applyOperation: string | null;
  acceptedRevision: number;
  revisionId: string;
  planDigest: string;
  evidenceSummary: string;
  inputFingerprint: string;
  deliveryId: string | null;
  deliveryProvenance: 'hosted' | 'local' | null;
  reviewState: string;
  uncertainty: string;
  createdAt: string;
}

export function currentCompletion(store: DocumentStore, cardId: string): CompletionRecord | null {
  const row = store.db
    .select()
    .from(completionRecords)
    .where(eq(completionRecords.cardId, cardId))
    .orderBy(desc(completionRecords.acceptedRevision))
    .get();
  if (row === undefined) return null;
  const revision = currentScopeRevision(store.db, cardId);
  return row.acceptedRevision === revision ? (row as CompletionRecord) : null;
}

export function listCompletions(store: DocumentStore, cardId: string): CompletionRecord[] {
  return store.db
    .select()
    .from(completionRecords)
    .where(eq(completionRecords.cardId, cardId))
    .orderBy(desc(completionRecords.acceptedRevision))
    .all() as CompletionRecord[];
}

export interface RecordCompletionInput {
  cardId: string;
  deliveryId?: string | undefined;
  deliveryProvenance?: 'hosted' | 'local' | undefined;
  reviewState?: string | undefined;
}

// Records the one local completion identity. Refuses unless the invariant
// holds; idempotent for the same accepted revision; a scope change after
// completion invalidates the current proof until a new revision completes.
export async function recordCompletion(store: DocumentStore, input: RecordCompletionInput): Promise<CompletionRecord> {
  const invariant = await completionInvariant(store, input.cardId);
  if (!invariant.satisfied) {
    throw new CompletionBlockedError(input.cardId, invariant.blockers);
  }
  const existing = store.db
    .select()
    .from(completionRecords)
    .where(and(eq(completionRecords.cardId, input.cardId), eq(completionRecords.acceptedRevision, invariant.acceptedRevision)))
    .get();
  if (existing !== undefined) return existing as CompletionRecord;
  const revisionRow = acceptedRevision(store.db, input.cardId, invariant.acceptedRevision)!;
  const snapshot = currentAcceptedSnapshot(store.db, input.cardId)!;
  const record: CompletionRecord = {
    id: `cp-${sha256(`${input.cardId}\n${invariant.acceptedRevision}\n${invariant.inputFingerprint ?? ''}`).slice(0, 12)}`,
    cardId: input.cardId,
    applyOperation: currentApply(store, input.cardId)?.id ?? null,
    acceptedRevision: invariant.acceptedRevision,
    revisionId: revisionRow.revisionId,
    planDigest: acceptedContentDigest(snapshot),
    evidenceSummary: JSON.stringify(invariant.criteria),
    inputFingerprint: invariant.inputFingerprint ?? '',
    deliveryId: input.deliveryId ?? null,
    deliveryProvenance: input.deliveryProvenance ?? null,
    reviewState: input.reviewState ?? 'not-recorded',
    uncertainty: JSON.stringify(invariant.uncertainty),
    createdAt: nowIso(),
  };
  runTx(store.db, (tx) => {
    tx.insert(completionRecords).values(record).onConflictDoNothing().run();
    tx.update(applyOperations)
      .set({ state: 'completed', updatedAt: nowIso() })
      .where(and(eq(applyOperations.cardId, input.cardId), eq(applyOperations.state, 'active')))
      .run();
  });
  return record;
}

export { listUnsettledOperations };

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DeckError } from '../board/errors.ts';
import { currentScopeRevision, scopeCriteria } from '../board/scope.ts';
import { evidenceRecords, evidenceRunLinks, evidenceRuns } from '../board/schema.ts';
import { getPolicy, loadRules, runCheckCmd } from '../board/rules.ts';
import type { DocumentStore } from '../board/store.ts';
import type { DeliveryPolicy } from '../board/types.ts';
import {
  captureExecutionInputs,
  fingerprintArtifact,
  type ArtifactProvenance,
  type ExecutionInputs,
} from './evidence-inputs.ts';

export type EvidenceResult = 'passed' | 'failed' | 'unavailable';
export type EvidenceKind = 'machine' | 'manual';

export interface EvidenceRecord {
  id: string;
  cardId: string;
  kind: EvidenceKind;
  criterionId: string | null;
  taskId: string | null;
  checkId: string | null;
  command: string | null;
  commandDigest: string | null;
  exitCode: number | null;
  result: EvidenceResult;
  producer: string;
  reviewer: string | null;
  rationale: string | null;
  scopeRevision: number;
  policyVersion: number;
  baseSha: string;
  headSha: string;
  inputFingerprint: string;
  inputCoverage: string;
  artifactPath: string | null;
  artifactSha256: string | null;
  artifactUnavailable: string | null;
  startedAt: string;
  endedAt: string;
  recordedAt: string;
}

function toRecord(row: typeof evidenceRecords.$inferSelect): EvidenceRecord {
  return { ...row };
}

export function listEvidence(store: DocumentStore, cardId: string): EvidenceRecord[] {
  return store.db
    .select()
    .from(evidenceRecords)
    .where(eq(evidenceRecords.cardId, cardId))
    .all()
    .map(toRecord);
}

function insertRecord(
  store: DocumentStore,
  input: {
    cardId: string;
    kind: EvidenceKind;
    criterionId: string | null;
    taskId?: string | null;
    checkId?: string | null;
    command?: string | null | undefined;
    exitCode?: number | null | undefined;
    result: EvidenceResult;
    producer: string;
    reviewer?: string | null;
    rationale?: string | null;
    inputs: ExecutionInputs;
    policyVersion: number;
    artifact?: ArtifactProvenance | undefined;
    startedAt: string;
    endedAt: string;
  },
): EvidenceRecord {
  const id = `ev-${createHash('sha256')
    .update(`${input.cardId}\n${input.criterionId ?? ''}\n${input.producer}\n${input.endedAt}\n${crypto.randomUUID()}`)
    .digest('hex')
    .slice(0, 16)}`;
  const row = {
    id,
    cardId: input.cardId,
    kind: input.kind,
    criterionId: input.criterionId,
    taskId: input.taskId ?? null,
    checkId: input.checkId ?? null,
    command: input.command ?? null,
    commandDigest: input.command !== undefined && input.command !== null
      ? createHash('sha256').update(input.command).digest('hex').slice(0, 16)
      : null,
    exitCode: input.exitCode ?? null,
    result: input.result,
    producer: input.producer,
    reviewer: input.reviewer ?? null,
    rationale: input.rationale ?? null,
    scopeRevision: currentScopeRevision(store.db, input.cardId),
    policyVersion: input.policyVersion,
    baseSha: input.inputs.baseSha,
    headSha: input.inputs.headSha,
    inputFingerprint: input.inputs.fingerprint,
    inputCoverage: JSON.stringify(input.inputs.coverage),
    artifactPath: input.artifact?.path ?? null,
    artifactSha256: input.artifact?.available === true ? input.artifact.sha256 : null,
    artifactUnavailable: input.artifact?.available === false ? input.artifact.reason : null,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    recordedAt: new Date().toISOString(),
  };
  store.db.insert(evidenceRecords).values(row).run();
  return toRecord(store.db.select().from(evidenceRecords).where(eq(evidenceRecords.id, id)).get()!);
}

function requirePolicy(store: DocumentStore, cardId: string): DeliveryPolicy {
  const policy = getPolicy(store, cardId);
  if (policy === undefined) {
    throw new DeckError(
      `card ${cardId} has no enrolled delivery/evidence policy — enroll one (deck policy <id> ...) before recording evidence`,
      { cardId },
    );
  }
  return policy;
}

function requireCriterionLink(
  store: DocumentStore,
  cardId: string,
  criterionId: string,
): { id: string; title: string; state: string } {
  const criterion = scopeCriteria(store.db, cardId).find((item) => item.id === criterionId);
  if (criterion === undefined || criterion.state !== 'active') {
    throw new DeckError(
      `criterion '${criterionId}' is not an active criterion of ${cardId} — evidence links only to current scope identity`,
      { cardId, criterionId },
    );
  }
  return criterion;
}

export interface CaptureCheckInput {
  checkId: string;
  criteria?: string[] | undefined;
  artifactPath?: string | undefined;
  declaredInputs?: string[] | undefined;
  base?: string | undefined;
}

export async function captureCheckEvidence(
  store: DocumentStore,
  cardId: string,
  input: CaptureCheckInput,
): Promise<EvidenceRecord[]> {
  const policy = requirePolicy(store, cardId);
  const rules = loadRules(store.projectPath);
  const principle = rules?.rules.principles.find((item) => item.id === input.checkId);
  if (principle?.check === undefined) {
    throw new DeckError(
      `check '${input.checkId}' is not a machine-checked principle in deck.rules.yaml — evidence capture runs configured checks only`,
      { cardId, checkId: input.checkId },
    );
  }
  const criteria = input.criteria ?? scopeCriteria(store.db, cardId)
    .filter((item) => item.state === 'active' && !policy.manualCriteria.includes(item.id))
    .map((item) => item.id);
  for (const criterionId of criteria) requireCriterionLink(store, cardId, criterionId);

  const before = await captureExecutionInputs(store.projectPath, {
    base: input.base,
    declaredInputs: input.declaredInputs,
  });
  const startedAt = new Date().toISOString();
  const run = await runCheckCmd(store.projectPath, principle.check);
  const endedAt = new Date().toISOString();
  const after = await captureExecutionInputs(store.projectPath, {
    base: input.base,
    declaredInputs: input.declaredInputs,
  });
  const mutated = before.fingerprint !== after.fingerprint;
  const result: EvidenceResult = mutated ? 'unavailable' : run.code === 0 ? 'passed' : 'failed';
  const artifact = input.artifactPath !== undefined
    ? fingerprintArtifact(store.projectPath, input.artifactPath)
    : undefined;
  const base = { inputs: after, policyVersion: policy.version, artifact, startedAt, endedAt };
  const records = criteria.map((criterionId) =>
    insertRecord(store, {
      cardId,
      kind: 'machine',
      criterionId,
      checkId: input.checkId,
      command: principle.check,
      exitCode: run.code,
      result,
      producer: 'rules-check',
      ...base,
    }),
  );
  if (criteria.length === 0) {
    records.push(
      insertRecord(store, {
        cardId,
        kind: 'machine',
        criterionId: null,
        checkId: input.checkId,
        command: principle.check,
        exitCode: run.code,
        result,
        producer: 'rules-check',
        ...base,
      }),
    );
  }
  return records;
}

export interface RecordManualInput {
  criterionId: string;
  reviewer: string;
  rationale: string;
  declaredInputs?: string[] | undefined;
  base?: string | undefined;
}

export async function recordManualEvidence(
  store: DocumentStore,
  cardId: string,
  input: RecordManualInput,
): Promise<EvidenceRecord> {
  const policy = requirePolicy(store, cardId);
  if (!policy.manualCriteria.includes(input.criterionId)) {
    throw new DeckError(
      `criterion '${input.criterionId}' is not designated manual in card ${cardId}'s policy — ` +
        `manual review cannot satisfy machine-required criteria; enroll the designation explicitly first`,
      { cardId, criterionId: input.criterionId },
    );
  }
  requireCriterionLink(store, cardId, input.criterionId);
  const inputs = await captureExecutionInputs(store.projectPath, {
    base: input.base,
    declaredInputs: input.declaredInputs,
  });
  const now = new Date().toISOString();
  return insertRecord(store, {
    cardId,
    kind: 'manual',
    criterionId: input.criterionId,
    result: 'passed',
    producer: 'manual-review',
    reviewer: input.reviewer,
    rationale: input.rationale,
    inputs,
    policyVersion: policy.version,
    startedAt: now,
    endedAt: now,
  });
}

export type CriterionEvidenceStatus = 'satisfied' | 'missing' | 'stale' | 'failed' | 'unavailable';

export interface CriterionEvidence {
  criterionId: string;
  title: string;
  requirement: 'machine' | 'manual';
  status: CriterionEvidenceStatus;
  recordId: string | null;
}

export interface EvidenceEvaluation {
  enrolled: boolean;
  policy: DeliveryPolicy | null;
  scopeRevision: number | null;
  fingerprint: string | null;
  criteria: CriterionEvidence[];
  eligible: boolean;
  reasons: string[];
}

export async function evaluateEligibility(store: DocumentStore, cardId: string): Promise<EvidenceEvaluation> {
  const policy = getPolicy(store, cardId);
  if (policy === undefined) {
    return {
      enrolled: false,
      policy: null,
      scopeRevision: null,
      fingerprint: null,
      criteria: [],
      eligible: false,
      reasons: ['no enrolled delivery/evidence policy — enroll explicitly before completion'],
    };
  }
  const scopeRevision = currentScopeRevision(store.db, cardId);
  const inputs = await captureExecutionInputs(store.projectPath, { declaredInputs: [] });
  const records = listEvidence(store, cardId);
  // Phase 4 evidence runs: a criterion is satisfied by a complete passed run
  // bound to the current scope revision, policy version and input fingerprint,
  // with the same standing as a legacy per-criterion record.
  const runRows = store.db
    .select()
    .from(evidenceRuns)
    .where(eq(evidenceRuns.cardId, cardId))
    .all();
  const runLinkRows = store.db
    .select()
    .from(evidenceRunLinks)
    .all()
    .filter((link) => runRows.some((run) => run.id === link.runId));
  const runByCriterion = new Map<string, string>();
  for (const run of runRows) {
    if (
      run.state !== 'complete' ||
      run.result !== 'passed' ||
      run.scopeRevision !== scopeRevision ||
      run.policyVersion !== policy.version ||
      run.inputFingerprint !== inputs.fingerprint
    ) {
      continue;
    }
    for (const link of runLinkRows) {
      if (link.runId === run.id && link.criterionId !== null && !runByCriterion.has(link.criterionId)) {
        runByCriterion.set(link.criterionId, run.id);
      }
    }
  }
  const incompleteRuns = runRows.filter((run) => run.state === 'incomplete');
  const criteria: CriterionEvidence[] = [];
  const reasons: string[] = [];
  for (const criterion of scopeCriteria(store.db, cardId).filter((item) => item.state === 'active')) {
    const manual = policy.manualCriteria.includes(criterion.id);
    const linked = records.filter((record) => record.criterionId === criterion.id);
    const current = linked.filter(
      (record) =>
        record.scopeRevision === scopeRevision &&
        record.policyVersion === policy.version &&
        record.inputFingerprint === inputs.fingerprint,
    );
    let status: CriterionEvidenceStatus;
    let recordId: string | null = null;
    if (manual) {
      const blocking = current.find(
        (record) =>
          record.kind === 'machine' &&
          record.result !== 'passed' &&
          policy.requiredChecks.includes(record.checkId ?? ''),
      );
      const valid = current.find((record) => record.kind === 'manual' && record.result === 'passed');
      if (blocking !== undefined) {
        status = blocking.result === 'failed' ? 'failed' : 'unavailable';
      } else if (valid !== undefined) {
        status = 'satisfied';
        recordId = valid.id;
      } else {
        status = current.length > 0 || linked.length > 0 ? 'stale' : 'missing';
      }
    } else {
      const failed = current.find((record) => record.kind === 'machine' && record.result === 'failed');
      const unavailable = current.find((record) => record.kind === 'machine' && record.result === 'unavailable');
      const passed = current.find((record) => record.kind === 'machine' && record.result === 'passed');
      if (failed !== undefined) {
        status = 'failed';
      } else if (unavailable !== undefined) {
        status = 'unavailable';
      } else if (passed !== undefined) {
        status = 'satisfied';
        recordId = passed.id;
      } else {
        status = linked.length > 0 ? 'stale' : 'missing';
      }
    }
    if (status !== 'satisfied') {
      reasons.push(`criterion "${criterion.title}" (${criterion.id}): ${status} ${manual ? '(manual)' : '(machine)'}`);
    }
    if (status !== 'satisfied' && runByCriterion.has(criterion.id)) {
      status = 'satisfied';
      recordId = runByCriterion.get(criterion.id)!;
      reasons.pop();
    } else if (status === 'satisfied' && recordId === null) {
      recordId = runByCriterion.get(criterion.id) ?? null;
    }
    criteria.push({ criterionId: criterion.id, title: criterion.title, requirement: manual ? 'manual' : 'machine', status, recordId });
  }
  const eligible = criteria.every((criterion) => criterion.status === 'satisfied');
  for (const run of incompleteRuns) {
    reasons.push(`evidence run ${run.id} is incomplete — visible but ineligible for completion`);
  }
  return { enrolled: true, policy, scopeRevision, fingerprint: inputs.fingerprint, criteria, eligible, reasons };
}

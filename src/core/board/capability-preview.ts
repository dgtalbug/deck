import { createHash } from 'node:crypto';
import type { CapabilityDelta } from './capability-deltas.ts';
import type { ProjectionEligibility } from './capability-eligibility.ts';

export interface CapabilityStatement {
  capabilityId: string;
  statementId: string;
  text: string;
  digest: string;
  state: 'current' | 'removed';
  sourceCardId?: string;
  sourceCriterionId?: string;
  sourceScopeRevision?: number;
  evidenceId?: string;
  deliveryId?: string;
}

export interface CapabilityStatementStatus extends CapabilityStatement {
  sourceCardId: string;
  sourceCriterionId: string;
  sourceScopeRevision: number;
  evidenceId: string;
  deliveryId: string;
  sourceDrift: 'none' | 'changed' | 'unknown';
}

export interface CapabilityPreviewChange {
  op: 'add' | 'modify' | 'remove';
  deltaId: string;
  capabilityId: string;
  statementId: string;
  before: string | null;
  after: string | null;
  sourceCardId?: string;
  sourceCriterionId?: string;
  sourceScopeRevision?: number;
  evidenceId?: string;
  deliveryId?: string;
}

export interface CapabilityPreviewConflict {
  deltaId: string;
  reason: string;
}

export interface CapabilityPreview {
  baseDigest: string;
  sourceDigest: string;
  contentDigest: string;
  changes: CapabilityPreviewChange[];
  conflicts: CapabilityPreviewConflict[];
  statements: CapabilityStatement[];
}

export interface StoredCapabilityPreview {
  id: string;
  batchId: string;
  preview: CapabilityPreview;
  resolution: { acceptedBy: string; rationale: string } | null;
}

export interface AppliedCapabilityProjection {
  versionId: string;
  version: number;
  contentDigest: string;
  reused: boolean;
}

export interface RollbackCapabilityPreview extends StoredCapabilityPreview {
  rollbackToVersionId: string;
}

export function statementKey(input: Pick<CapabilityStatement, 'capabilityId' | 'statementId'>): string {
  return `${input.capabilityId}:${input.statementId}`;
}

export function capabilityStatementDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function contentAddress(batchId: string, preview: CapabilityPreview): string {
  return `cap-prev-${digest({ batchId, preview }).slice(0, 16)}`;
}

export function previewCapabilityProjection(
  baseStatements: CapabilityStatement[],
  deltas: CapabilityDelta[],
  eligibilityByDeltaId: Map<string, ProjectionEligibility>,
): CapabilityPreview {
  const statements = new Map(baseStatements.map((statement) => [statementKey(statement), { ...statement }]));
  const conflicts: CapabilityPreviewConflict[] = [];
  const changes: CapabilityPreviewChange[] = [];

  for (const delta of deltas) {
    const key = statementKey(delta);
    const eligibility = eligibilityByDeltaId.get(delta.deltaId);
    if (eligibility === undefined || eligibility.status !== 'eligible') {
      conflicts.push({ deltaId: delta.deltaId, reason: `source is ${eligibility?.status ?? 'unknown'}` });
      continue;
    }
    const existing = statements.get(key);
    if (delta.op === 'add') {
      if (existing !== undefined && existing.state === 'current') {
        conflicts.push({ deltaId: delta.deltaId, reason: 'cannot add an existing current statement' });
        continue;
      }
      const next = {
        capabilityId: delta.capabilityId,
        statementId: delta.statementId,
        text: delta.statementText,
        digest: capabilityStatementDigest(delta.statementText),
        state: 'current' as const,
        sourceCardId: delta.source.cardId,
        sourceCriterionId: delta.source.criterionId,
        sourceScopeRevision: delta.source.scopeRevision,
        evidenceId: delta.source.evidenceId,
        deliveryId: delta.source.deliveryId,
      };
      statements.set(key, next);
      changes.push({
        op: delta.op,
        deltaId: delta.deltaId,
        capabilityId: delta.capabilityId,
        statementId: delta.statementId,
        before: null,
        after: next.text,
        sourceCardId: delta.source.cardId,
        sourceCriterionId: delta.source.criterionId,
        sourceScopeRevision: delta.source.scopeRevision,
        evidenceId: delta.source.evidenceId,
        deliveryId: delta.source.deliveryId,
      });
      continue;
    }
    if (existing === undefined || existing.state !== 'current') {
      conflicts.push({ deltaId: delta.deltaId, reason: 'cannot change an absent current statement' });
      continue;
    }
    if (existing.digest !== delta.expectedPriorDigest) {
      conflicts.push({ deltaId: delta.deltaId, reason: 'expected prior digest does not match current statement' });
      continue;
    }
    if (delta.op === 'modify') {
      const next = {
        ...existing,
        text: delta.statementText,
        digest: capabilityStatementDigest(delta.statementText),
        sourceCardId: delta.source.cardId,
        sourceCriterionId: delta.source.criterionId,
        sourceScopeRevision: delta.source.scopeRevision,
        evidenceId: delta.source.evidenceId,
        deliveryId: delta.source.deliveryId,
      };
      statements.set(key, next);
      changes.push({
        op: delta.op,
        deltaId: delta.deltaId,
        capabilityId: delta.capabilityId,
        statementId: delta.statementId,
        before: existing.text,
        after: next.text,
        sourceCardId: delta.source.cardId,
        sourceCriterionId: delta.source.criterionId,
        sourceScopeRevision: delta.source.scopeRevision,
        evidenceId: delta.source.evidenceId,
        deliveryId: delta.source.deliveryId,
      });
    } else {
      const next = { ...existing, state: 'removed' as const };
      statements.set(key, next);
      changes.push({
        op: delta.op,
        deltaId: delta.deltaId,
        capabilityId: delta.capabilityId,
        statementId: delta.statementId,
        before: existing.text,
        after: null,
        sourceCardId: delta.source.cardId,
        sourceCriterionId: delta.source.criterionId,
        sourceScopeRevision: delta.source.scopeRevision,
        evidenceId: delta.source.evidenceId,
        deliveryId: delta.source.deliveryId,
      });
    }
  }

  const ordered = [...statements.values()].sort((a, b) => statementKey(a).localeCompare(statementKey(b)));
  return {
    baseDigest: digest(baseStatements),
    sourceDigest: digest(deltas.map((delta) => delta.source)),
    contentDigest: digest(ordered),
    changes,
    conflicts,
    statements: ordered,
  };
}

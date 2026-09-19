import { eq } from 'drizzle-orm';
import { capabilityDeltas, capabilityPreviews, capabilityStatements, capabilityVersions } from './schema.ts';
import { DeckError } from './errors.ts';
import { runTx, type DocumentStore } from './store.ts';
import {
  capabilityStatementDigest,
  contentAddress,
  digest,
  previewCapabilityProjection,
  statementKey,
  type AppliedCapabilityProjection,
  type CapabilityPreview,
  type CapabilityPreviewChange,
  type CapabilityStatement,
  type CapabilityStatementStatus,
  type RollbackCapabilityPreview,
  type StoredCapabilityPreview,
} from './capability-preview.ts';

export {
  capabilityStatementDigest,
  contentAddress,
  digest,
  previewCapabilityProjection,
  statementKey,
};
export type {
  AppliedCapabilityProjection,
  CapabilityPreview,
  CapabilityPreviewChange,
  CapabilityPreviewConflict,
  CapabilityStatement,
  CapabilityStatementStatus,
  RollbackCapabilityPreview,
  StoredCapabilityPreview,
} from './capability-preview.ts';

export function persistCapabilityPreview(
  store: DocumentStore,
  batchId: string,
  preview: CapabilityPreview,
  resolution: { acceptedBy: string; rationale: string } | null = null,
): StoredCapabilityPreview {
  const id = contentAddress(batchId, preview);
  const previewJson = JSON.stringify({ preview, resolution });
  const now = new Date().toISOString();
  store.db.insert(capabilityPreviews)
    .values({
      id,
      batchId,
      baseDigest: preview.baseDigest,
      sourceDigest: preview.sourceDigest,
      contentDigest: preview.contentDigest,
      previewJson,
      state: preview.conflicts.length === 0 ? 'previewed' : 'conflicted',
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
  return { id, batchId, preview, resolution };
}

export function readCapabilityPreview(store: DocumentStore, id: string): StoredCapabilityPreview | null {
  const row = store.db.select().from(capabilityPreviews).all().find((item) => item.id === id);
  if (row === undefined) return null;
  const parsed = JSON.parse(row.previewJson) as {
    preview: CapabilityPreview;
    resolution: { acceptedBy: string; rationale: string } | null;
  };
  return { id: row.id, batchId: row.batchId, preview: parsed.preview, resolution: parsed.resolution };
}

export function currentCapabilityStatements(store: DocumentStore): CapabilityStatement[] {
  const latest = store.db.select().from(capabilityVersions).all().sort((a, b) => b.version - a.version)[0];
  if (latest === undefined) return [];
  return rowsToCapabilityStatements(store.db.select().from(capabilityStatements).all().filter((row) => row.projectionVersionId === latest.id));
}

function rowsToCapabilityStatements(rows: Array<typeof capabilityStatements.$inferSelect>): CapabilityStatement[] {
  return rows.map((row) => ({
    capabilityId: row.capabilityId,
    statementId: row.statementId,
    text: row.text,
    digest: row.digest,
    state: row.state,
    sourceCardId: row.sourceCardId,
    sourceCriterionId: row.sourceCriterionId,
    sourceScopeRevision: row.sourceScopeRevision,
    evidenceId: row.evidenceId,
    deliveryId: row.deliveryId,
  })).sort((a, b) => statementKey(a).localeCompare(statementKey(b)));
}

export function previewCapabilityRollback(
  store: DocumentStore,
  batchId: string,
  rollbackToVersionId: string,
): RollbackCapabilityPreview {
  const targetVersion = store.db.select().from(capabilityVersions).all().find((row) => row.id === rollbackToVersionId);
  if (targetVersion === undefined) {
    throw new DeckError(`capability version '${rollbackToVersionId}' not found`, { rollbackToVersionId });
  }
  const current = currentCapabilityStatements(store);
  const target = rowsToCapabilityStatements(
    store.db.select().from(capabilityStatements).all().filter((row) => row.projectionVersionId === rollbackToVersionId),
  );
  const targetByKey = new Map(target.map((statement) => [statementKey(statement), statement]));
  const currentByKey = new Map(current.map((statement) => [statementKey(statement), statement]));
  const changes: CapabilityPreviewChange[] = [];

  for (const statement of target) {
    const existing = currentByKey.get(statementKey(statement));
    if (statement.state === 'removed') {
      if (existing !== undefined && existing.state === 'current') {
        changes.push({
          op: 'remove',
          deltaId: `rollback:${rollbackToVersionId}:${statement.capabilityId}:${statement.statementId}:remove`,
          capabilityId: statement.capabilityId,
          statementId: statement.statementId,
          before: existing.text,
          after: null,
        });
      }
    } else if (existing === undefined || existing.state !== 'current') {
      changes.push({
        op: 'add',
        deltaId: `rollback:${rollbackToVersionId}:${statement.capabilityId}:${statement.statementId}:add`,
        capabilityId: statement.capabilityId,
        statementId: statement.statementId,
        before: null,
        after: statement.text,
      });
    } else if (existing.digest !== statement.digest || existing.state !== statement.state) {
      changes.push({
        op: 'modify',
        deltaId: `rollback:${rollbackToVersionId}:${statement.capabilityId}:${statement.statementId}:modify`,
        capabilityId: statement.capabilityId,
        statementId: statement.statementId,
        before: existing.text,
        after: statement.text,
      });
    }
  }
  for (const statement of current) {
    if (statement.state === 'current' && !targetByKey.has(statementKey(statement))) {
      changes.push({
        op: 'remove',
        deltaId: `rollback:${rollbackToVersionId}:${statement.capabilityId}:${statement.statementId}:remove`,
        capabilityId: statement.capabilityId,
        statementId: statement.statementId,
        before: statement.text,
        after: null,
      });
    }
  }

  const preview: CapabilityPreview = {
    baseDigest: digest(current),
    sourceDigest: digest({ rollbackToVersionId, contentDigest: targetVersion.contentDigest }),
    contentDigest: digest(target),
    changes,
    conflicts: [],
    statements: target,
  };
  return { ...persistCapabilityPreview(store, batchId, preview), rollbackToVersionId };
}

export function readCurrentCapabilityStatementStatus(
  store: DocumentStore,
  currentSourceRevisions: Map<string, number | null>,
): CapabilityStatementStatus[] {
  const latest = store.db.select().from(capabilityVersions).all().sort((a, b) => b.version - a.version)[0];
  if (latest === undefined) return [];
  return store.db.select().from(capabilityStatements).all()
    .filter((row) => row.projectionVersionId === latest.id)
    .map((row) => {
      const sourceKey = `${row.sourceCardId}:${row.sourceCriterionId}`;
      const currentRevision = currentSourceRevisions.get(sourceKey);
      const sourceDrift: 'none' | 'changed' | 'unknown' = currentRevision === undefined || currentRevision === null
        ? 'unknown'
        : currentRevision === row.sourceScopeRevision ? 'none' : 'changed';
      return {
        capabilityId: row.capabilityId,
        statementId: row.statementId,
        text: row.text,
        digest: row.digest,
        state: row.state,
        sourceCardId: row.sourceCardId,
        sourceCriterionId: row.sourceCriterionId,
        sourceScopeRevision: row.sourceScopeRevision,
        evidenceId: row.evidenceId,
        deliveryId: row.deliveryId,
        sourceDrift,
      };
    })
    .sort((a, b) => statementKey(a).localeCompare(statementKey(b)));
}

export function applyCapabilityPreview(
  store: DocumentStore,
  previewId: string,
  input: { acceptedBy: string; rationale: string },
): AppliedCapabilityProjection {
  const stored = readCapabilityPreview(store, previewId);
  if (stored === null) throw new DeckError(`capability preview '${previewId}' not found`, { previewId });
  if (stored.preview.conflicts.length > 0) {
    throw new DeckError(`capability preview '${previewId}' has unresolved conflicts`, { previewId });
  }
  const existingVersion = store.db.select().from(capabilityVersions).all().find((row) => row.previewId === previewId);
  if (existingVersion !== undefined) {
    return {
      versionId: existingVersion.id,
      version: existingVersion.version,
      contentDigest: existingVersion.contentDigest,
      reused: true,
    };
  }
  const currentDigest = digest(currentCapabilityStatements(store));
  if (currentDigest !== stored.preview.baseDigest) {
    store.db.update(capabilityPreviews).set({ state: 'stale' }).where(eq(capabilityPreviews.id, previewId)).run();
    throw new DeckError(`capability preview '${previewId}' is stale`, {
      previewId,
      expected: stored.preview.baseDigest,
      actual: currentDigest,
    });
  }
  for (const change of stored.preview.changes) {
    const existingDelta = store.db.select().from(capabilityDeltas).all().find((row) => row.deltaId === change.deltaId);
    const changeDigest = capabilityStatementDigest(JSON.stringify(change));
    if (existingDelta !== undefined && existingDelta.statementDigest !== changeDigest) {
      throw new DeckError(`capability delta '${change.deltaId}' was already applied with different content`, {
        deltaId: change.deltaId,
      });
    }
  }

  const previous = store.db.select().from(capabilityVersions).all();
  const version = previous.length + 1;
  const versionId = `cap-ver-${version}-${digest({ previewId, contentDigest: stored.preview.contentDigest }).slice(0, 16)}`;
  const now = new Date().toISOString();
  runTx(store.db, (tx) => {
    tx.insert(capabilityVersions)
      .values({
        id: versionId,
        version,
        baseDigest: stored.preview.baseDigest,
        contentDigest: stored.preview.contentDigest,
        previewId,
        acceptedBy: input.acceptedBy,
        rationale: input.rationale,
        createdAt: now,
      })
      .run();
    for (const statement of stored.preview.statements) {
      tx.insert(capabilityStatements)
        .values({
          id: `cap-st-${capabilityStatementDigest(`${versionId}:${statement.capabilityId}:${statement.statementId}`).slice(0, 16)}`,
          capabilityId: statement.capabilityId,
          statementId: statement.statementId,
          version,
          text: statement.text,
          digest: statement.digest,
          sourceCardId: statement.sourceCardId ?? '',
          sourceCriterionId: statement.sourceCriterionId ?? '',
          sourceScopeRevision: statement.sourceScopeRevision ?? 0,
          evidenceId: statement.evidenceId ?? '',
          deliveryId: statement.deliveryId ?? '',
          state: statement.state,
          projectionVersionId: versionId,
          createdAt: now,
        })
        .run();
    }
    for (const change of stored.preview.changes) {
      tx.insert(capabilityDeltas)
        .values({
          id: `cap-delta-${capabilityStatementDigest(`${versionId}:${change.deltaId}`).slice(0, 16)}`,
          batchId: stored.batchId,
          deltaId: change.deltaId,
          op: change.op,
          capabilityId: change.capabilityId,
          statementId: change.statementId,
          statementDigest: capabilityStatementDigest(JSON.stringify(change)),
          sourceCardId: change.sourceCardId ?? '',
          sourceCriterionId: change.sourceCriterionId ?? '',
          sourceScopeRevision: change.sourceScopeRevision ?? 0,
          evidenceId: change.evidenceId ?? '',
          deliveryId: change.deliveryId ?? '',
          previewId,
          appliedVersionId: versionId,
          createdAt: now,
        })
        .run();
    }
    tx.update(capabilityPreviews).set({ state: 'accepted' }).where(eq(capabilityPreviews.id, previewId)).run();
  });
  return { versionId, version, contentDigest: stored.preview.contentDigest, reused: false };
}

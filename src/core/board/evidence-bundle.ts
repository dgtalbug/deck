import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  cards,
  deliveries,
  epicCriteria,
  evidenceRecords,
  scopeItems,
  scopeRevisions,
  specs,
  tasks,
} from './schema.ts';
import { NotFoundError } from './errors.ts';
import { canonicalProjectId } from './provider-operations.ts';
import type { DocumentStore } from './store.ts';
import type {
  EvidenceBundle,
  EvidenceBundleAssurance,
  EvidenceBundleFreshness,
  EvidenceBundleOmission,
  EvidenceBundleRecord,
} from './evidence-bundle-schema.ts';

function entityId(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

export function serializeEvidenceBundle(bundle: EvidenceBundle): string {
  return `${stableJson(bundle)}\n`;
}

export function canonicalEvidenceBundleDigest(bundle: EvidenceBundle): string {
  return digestJson({ ...bundle, snapshot: { ...bundle.snapshot, digest: null, createdAt: null } });
}

function latestBy<T, K>(items: T[], keyOf: (item: T) => K, versionOf: (item: T) => number): Map<K, T> {
  const out = new Map<K, T>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = out.get(key);
    if (existing === undefined || versionOf(item) > versionOf(existing)) out.set(key, item);
  }
  return out;
}

function scopedOmission(field: string, note: string): EvidenceBundleOmission {
  return { field, reason: 'unavailable', note };
}

function safeUrl(url: string | null): string | null {
  if (url === null) return null;
  return /^https:\/\/github\.com\//.test(url) ? url : null;
}

function safeRelativePath(path: string | null): string | null {
  if (path === null || isAbsolute(path)) return null;
  const normalized = normalize(path).replaceAll('\\', '/');
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') return null;
  return normalized;
}

export interface EvidenceBundleSnapshotOptions {
  createdAt?: string | null | undefined;
}

export function collectEvidenceBundleSnapshot(
  store: DocumentStore,
  epicId: string,
  options: EvidenceBundleSnapshotOptions = {},
): EvidenceBundle {
  const epic = store.db.select().from(cards).where(and(eq(cards.id, epicId), eq(cards.type, 'epic'))).get();
  if (epic === undefined) {
    throw new NotFoundError('epic', epicId);
  }

  const children = store.db
    .select()
    .from(cards)
    .where(eq(cards.epicId, epicId))
    .orderBy(asc(cards.createdAt), asc(cards.id))
    .all();
  const childIds = children.map((child) => child.id);
  const allCardIds = [epicId, ...childIds];

  const taskRows = childIds.length === 0
    ? []
    : store.db.select().from(tasks).where(inArray(tasks.cardId, childIds)).orderBy(asc(tasks.idx)).all();
  const scopeRows = childIds.length === 0
    ? []
    : store.db.select().from(scopeItems).where(inArray(scopeItems.cardId, childIds)).all();
  const scopeRevisionRows = childIds.length === 0
    ? []
    : store.db.select().from(scopeRevisions).where(inArray(scopeRevisions.cardId, childIds)).all();
  const specRows = childIds.length === 0
    ? []
    : store.db.select().from(specs).where(inArray(specs.cardId, childIds)).all();
  const evidenceRows = childIds.length === 0
    ? []
    : store.db.select().from(evidenceRecords).where(inArray(evidenceRecords.cardId, childIds)).all();
  const deliveryRows = childIds.length === 0
    ? []
    : store.db.select().from(deliveries).where(inArray(deliveries.cardId, childIds)).all();
  const epicCriterionRows = store.db.select().from(epicCriteria).where(eq(epicCriteria.epicId, epicId)).all();

  const latestScope = latestBy(scopeRevisionRows, (row) => row.cardId, (row) => row.revision);
  const latestSpec = latestBy(specRows, (row) => row.cardId, (row) => row.version);
  const latestDelivery = latestBy(deliveryRows, (row) => row.cardId, (row) => row.attempt);
  const omissions: EvidenceBundleOmission[] = [
    { field: 'evidence.command', reason: 'raw-command', note: 'export includes command digests, not raw command strings' },
    { field: 'checkpoint.entries.text', reason: 'checkpoint-body', note: 'checkpoint bodies are local working notes' },
  ];

  for (const child of children) {
    if (latestScope.get(child.id) === undefined) {
      omissions.push(scopedOmission(`stories.${child.id}.scopeDigest`, 'no persisted scope revision digest is available'));
    }
    if (latestSpec.get(child.id) === undefined) {
      omissions.push(scopedOmission(`stories.${child.id}.specVersion`, 'no rendered spec version is available'));
    }
  }

  for (const delivery of deliveryRows) {
    if (delivery.prUrl !== null && safeUrl(delivery.prUrl) === null) {
      omissions.push({ field: `deliveries.${delivery.id}.prUrl`, reason: 'unsafe-link', note: 'delivery link scheme or host is not export-safe' });
    }
  }
  for (const evidence of evidenceRows) {
    if (evidence.artifactPath !== null && safeRelativePath(evidence.artifactPath) === null) {
      omissions.push({ field: `evidence.${evidence.id}.artifactPath`, reason: 'absolute-path', note: 'artifact path is not a safe project-relative reference' });
    }
  }

  const evidence: EvidenceBundleRecord[] = evidenceRows
    .map((row) => {
      const latestScopeRow = latestScope.get(row.cardId);
      const delivery = latestDelivery.get(row.cardId);
	      const freshness: EvidenceBundleFreshness = latestScopeRow === undefined
	        ? 'unknown'
	        : row.scopeRevision === latestScopeRow.revision ? 'current' : 'stale';
	      const assurance: EvidenceBundleAssurance = delivery?.provenance ?? 'unknown';
	      return {
        id: entityId('evidence', row.id),
        source: {
          cardId: entityId('card', row.cardId),
          criterionId: row.criterionId === null ? null : entityId('criterion', row.criterionId),
          taskId: row.taskId === null ? null : entityId('task', row.taskId),
          scopeRevision: row.scopeRevision,
          scopeDigest: scopeRevisionRows.find((scope) => scope.cardId === row.cardId && scope.revision === row.scopeRevision)?.digest ?? null,
          specVersion: latestSpec.get(row.cardId)?.version ?? null,
          specChecksum: latestSpec.get(row.cardId)?.checksum ?? null,
        },
        kind: row.kind,
        result: row.result,
        freshness,
	        assurance,
        policyVersion: row.policyVersion,
        recordedAt: row.recordedAt,
        producer: row.producer,
        reviewer: row.reviewer,
        checkId: row.checkId,
        commandDigest: row.commandDigest,
        inputFingerprint: row.inputFingerprint,
        artifact: row.artifactPath === null && row.artifactSha256 === null && row.artifactUnavailable === null
          ? null
          : {
              id: entityId('artifact', row.artifactSha256 ?? row.artifactUnavailable ?? row.id),
              path: safeRelativePath(row.artifactPath),
              sha256: row.artifactSha256,
              unavailable: row.artifactUnavailable,
            },
        extensions: {},
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const bundleWithoutDigest = {
    schema: 'deck.evidence-bundle' as const,
    version: '1.0.0' as const,
    project: { id: entityId('project', canonicalProjectId(store)), name: store.projectPath.split('/').at(-1) ?? 'deck' },
    snapshot: { digest: '0'.repeat(64), createdAt: options.createdAt ?? null },
    epics: [
      {
        id: entityId('epic', epic.id),
        title: epic.title,
        intentRevision: null,
        historical: epic.historyAt !== null,
        storyIds: childIds.map((id) => entityId('card', id)).sort(),
        criteria: epicCriterionRows
          .map((row) => ({
            id: entityId('criterion', row.id),
            title: row.title,
            state: row.state,
            firstRevision: row.firstRevision,
            lastRevision: null,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        extensions: {},
      },
    ],
    stories: children
      .map((child) => {
        const scope = latestScope.get(child.id);
        const spec = latestSpec.get(child.id);
        return {
          id: entityId('card', child.id),
          title: child.title,
          verb: child.verb,
          lane: child.lane,
          parentEpicId: child.epicId === null ? null : entityId('epic', child.epicId),
          scopeRevision: child.scopeRevision ?? 0,
          scopeDigest: scope?.digest ?? null,
          specVersion: spec?.version ?? null,
          specChecksum: spec?.checksum ?? null,
          historical: child.historyAt !== null,
          criteria: scopeRows
            .filter((row) => row.cardId === child.id)
            .map((row) => ({
              id: entityId('criterion', row.id),
              title: row.title,
              state: row.state,
              firstRevision: row.firstRevision,
              lastRevision: row.lastRevision,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          tasks: taskRows
            .filter((row) => row.cardId === child.id)
            .map((row) => ({ id: entityId('task', row.id), title: row.title, done: row.done }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          extensions: {},
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
    decisions: [],
    evidence,
	    deliveries: deliveryRows
	      .map((row) => ({
        id: entityId('delivery', row.id),
        cardId: entityId('card', row.cardId),
        attempt: row.attempt,
        state: row.state,
	        assurance: (row.provenance ?? 'unknown') as EvidenceBundleAssurance,
        policyVersion: row.policyVersion,
        scopeRevision: row.scopeRevision,
        inputFingerprint: row.inputFingerprint,
        prUrl: safeUrl(row.prUrl),
        mergeSha: row.mergeSha,
        refusalReason: row.refusalReason,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    omissions: omissions.sort((a, b) => `${a.field}:${a.reason}`.localeCompare(`${b.field}:${b.reason}`)),
    extensions: {},
  };

  return {
    ...bundleWithoutDigest,
    snapshot: {
      ...bundleWithoutDigest.snapshot,
      digest: canonicalEvidenceBundleDigest(bundleWithoutDigest),
    },
  };
}

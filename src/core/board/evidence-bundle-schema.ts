import { z } from 'zod';

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = '1.0.0';
export const EVIDENCE_BUNDLE_MAJOR_VERSION = 1;

const stableId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digest = /^[a-f0-9]{16,64}$/;
const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export type EvidenceBundleResult = 'passed' | 'failed' | 'unavailable';
export type EvidenceBundleFreshness = 'current' | 'stale' | 'unknown';
export type EvidenceBundleAssurance = 'hosted' | 'local' | 'unknown';
export type EvidenceBundleOmissionReason =
  | 'raw-command'
  | 'raw-log'
  | 'environment'
  | 'checkpoint-body'
  | 'absolute-path'
  | 'unsafe-link'
  | 'unavailable'
  | 'unsupported';

const extensionBag = z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\//), z.unknown()).default({});

export const evidenceBundleSourceRefSchema = z.object({
  cardId: z.string().regex(stableId),
  criterionId: z.string().regex(stableId).nullable(),
  taskId: z.string().regex(stableId).nullable(),
  scopeRevision: z.number().int().nonnegative(),
  scopeDigest: z.string().regex(digest).nullable(),
  specVersion: z.number().int().positive().nullable(),
  specChecksum: z.string().regex(digest).nullable(),
});

export const evidenceBundleTaskSchema = z.object({
  id: z.string().regex(stableId),
  title: z.string().min(1),
  done: z.boolean(),
});

export const evidenceBundleCriterionSchema = z.object({
  id: z.string().regex(stableId),
  title: z.string().min(1),
  state: z.enum(['active', 'removed', 'superseded', 'deferred']),
  firstRevision: z.number().int().nonnegative().nullable(),
  lastRevision: z.number().int().nonnegative().nullable(),
});

export const evidenceBundleStorySchema = z.object({
  id: z.string().regex(stableId),
  title: z.string().min(1),
  verb: z.string().min(1).nullable(),
  lane: z.enum(['todo', 'groomed', 'active', 'verify', 'done']),
  parentEpicId: z.string().regex(stableId).nullable(),
  scopeRevision: z.number().int().nonnegative(),
  scopeDigest: z.string().regex(digest).nullable(),
  specVersion: z.number().int().positive().nullable(),
  specChecksum: z.string().regex(digest).nullable(),
  historical: z.boolean(),
  criteria: z.array(evidenceBundleCriterionSchema),
  tasks: z.array(evidenceBundleTaskSchema),
  extensions: extensionBag,
});

export const evidenceBundleEpicSchema = z.object({
  id: z.string().regex(stableId),
  title: z.string().min(1),
  intentRevision: z.number().int().nonnegative().nullable(),
  historical: z.boolean(),
  storyIds: z.array(z.string().regex(stableId)),
  criteria: z.array(evidenceBundleCriterionSchema),
  extensions: extensionBag,
});

export const evidenceBundleDecisionSchema = z.object({
  id: z.string().regex(stableId),
  title: z.string().min(1),
  source: z.string().min(1),
  excerpt: z.string().min(1),
});

export const evidenceBundleDeliverySchema = z.object({
  id: z.string().regex(stableId),
  cardId: z.string().regex(stableId),
  attempt: z.number().int().positive(),
  state: z.enum(['prepared', 'pending', 'delivered', 'refused']),
  assurance: z.enum(['hosted', 'local', 'unknown']),
  policyVersion: z.number().int().positive(),
  scopeRevision: z.number().int().nonnegative(),
  inputFingerprint: z.string().regex(digest).nullable(),
  prUrl: z.string().url().nullable(),
  mergeSha: z.string().regex(digest).nullable(),
  refusalReason: z.string().min(1).nullable(),
});

export const evidenceBundleRecordSchema = z.object({
  id: z.string().regex(stableId),
  source: evidenceBundleSourceRefSchema,
  kind: z.enum(['machine', 'manual']),
  result: z.enum(['passed', 'failed', 'unavailable']),
  freshness: z.enum(['current', 'stale', 'unknown']),
  assurance: z.enum(['hosted', 'local', 'unknown']),
  policyVersion: z.number().int().positive().nullable(),
  recordedAt: z.string().regex(isoDate),
  producer: z.string().min(1),
  reviewer: z.string().min(1).nullable(),
  checkId: z.string().min(1).nullable(),
  commandDigest: z.string().regex(digest).nullable(),
  inputFingerprint: z.string().regex(digest).nullable(),
  artifact: z.object({
    id: z.string().regex(stableId),
    path: z.string().min(1).nullable(),
    sha256: z.string().regex(digest).nullable(),
    unavailable: z.string().min(1).nullable(),
  }).nullable(),
  extensions: extensionBag,
});

export const evidenceBundleOmissionSchema = z.object({
  field: z.string().min(1),
  reason: z.enum([
    'raw-command',
    'raw-log',
    'environment',
    'checkpoint-body',
    'absolute-path',
    'unsafe-link',
    'unavailable',
    'unsupported',
  ]),
  note: z.string().min(1),
});

export const evidenceBundleSchema = z.object({
  schema: z.literal('deck.evidence-bundle'),
  version: z.literal(EVIDENCE_BUNDLE_SCHEMA_VERSION),
  project: z.object({
    id: z.string().regex(stableId),
    name: z.string().min(1),
  }),
  snapshot: z.object({
    digest: z.string().regex(digest),
    createdAt: z.string().regex(isoDate).nullable(),
  }),
  epics: z.array(evidenceBundleEpicSchema),
  stories: z.array(evidenceBundleStorySchema),
  decisions: z.array(evidenceBundleDecisionSchema),
  evidence: z.array(evidenceBundleRecordSchema),
  deliveries: z.array(evidenceBundleDeliverySchema),
  omissions: z.array(evidenceBundleOmissionSchema),
  extensions: extensionBag,
}).strict();

export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;
export type EvidenceBundleRecord = z.infer<typeof evidenceBundleRecordSchema>;
export type EvidenceBundleOmission = z.infer<typeof evidenceBundleOmissionSchema>;

export interface EvidenceBundleParseResult {
  bundle: EvidenceBundle;
  unsupportedRootFields: string[];
}

function majorVersion(version: string): number | null {
  const match = /^(\d+)\./.exec(version);
  return match === null ? null : Number(match[1]);
}

export function parseEvidenceBundle(input: unknown): EvidenceBundleParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('evidence bundle must be a JSON object');
  }
  const record = input as Record<string, unknown>;
  const version = typeof record.version === 'string' ? record.version : null;
  const major = version === null ? null : majorVersion(version);
  if (major === null) {
    throw new Error('evidence bundle version is missing or invalid');
  }
  if (major !== EVIDENCE_BUNDLE_MAJOR_VERSION) {
    throw new Error(`unsupported evidence bundle major version ${major}; expected ${EVIDENCE_BUNDLE_MAJOR_VERSION}.x`);
  }

  const allowed = new Set(Object.keys(evidenceBundleSchema.shape));
  const unsupportedRootFields = Object.keys(record).filter((key) => !allowed.has(key));
  const sanitized = Object.fromEntries(Object.entries(record).filter(([key]) => allowed.has(key)));
  const bundle = evidenceBundleSchema.parse(sanitized);
  return { bundle, unsupportedRootFields };
}

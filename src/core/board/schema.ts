import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type { CardType, Lane, VerbName } from './types.ts';

// One cards table with a type discriminator: grooming converts the same row
// (same id) from note → verb, per the epic's convertToVerbItem contract.
export const cards = sqliteTable('cards', {
  id: text('id').primaryKey(),
  type: text('type', { enum: ['note', 'verb', 'tweak'] }).$type<CardType>().notNull(),
  title: text('title').notNull(),
  verb: text('verb').$type<VerbName | null>(),
  lane: text('lane', { enum: ['todo', 'groomed', 'active', 'verify', 'done'] }).$type<Lane>().notNull(),
  position: real('position').notNull(),
  specPath: text('spec_path'),
  requirement: text('requirement'),
  // epic planning: parent epic pointer (null = unattached)
  epicId: text('epic_id'),
  research: text('research'), // JSON-encoded Research
  blockedReason: text('blocked_reason'),
  blockedAt: text('blocked_at'),
  // E03 scope identity: current accepted-scope revision (null = legacy card,
  // criterion identity unclassified until a reviewed edit supplies it).
  scopeRevision: integer('scope_revision'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const tasks = sqliteTable(
  'tasks',
  {
    cardId: text('card_id').notNull(),
    idx: integer('idx').notNull(),
    id: text('id').notNull(),
    title: text('title').notNull(),
    done: integer('done', { mode: 'boolean' }).notNull().default(false),
    addedByVerify: integer('added_by_verify', { mode: 'boolean' }),
  },
  (table) => [primaryKey({ columns: [table.cardId, table.idx] })],
);

// Spec store (epic P1a): rendered-markdown versions per card — dumb blobs +
// checksums, never delta rows. Content identity is the checksum, so identical
// renders do not create versions.
export const specs = sqliteTable(
  'specs',
  {
    cardId: text('card_id').notNull(),
    version: integer('version').notNull(),
    markdown: text('markdown').notNull(),
    checksum: text('checksum').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.cardId, table.version] })],
);

// One card ↔ at most one mapped issue (decision #3: one issue per change).
// `state` is deck's last-observed lifecycle: 'draft' = published at groom
// (spec-type-registry), 'open' = activated at verb start, 'closed' = archived.
export const issueMap = sqliteTable('issue_map', {
  cardId: text('card_id').primaryKey(),
  issueNumber: integer('issue_number').notNull(),
  state: text('state', { enum: ['draft', 'open', 'closed'] }).$type<'draft' | 'open' | 'closed'>().notNull(),
  checksum: text('checksum').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Offline publish queue: one pending entry per card (newest checksum wins),
// flushed in enqueued_at order by syncProject.
export const publishQueue = sqliteTable('publish_queue', {
  cardId: text('card_id').primaryKey(),
  checksum: text('checksum').notNull(),
  enqueuedAt: text('enqueued_at').notNull(),
});

// User verbs registered through `deck workflow` — same engine, same lanes;
// one row per name, no config file.
export const userVerbs = sqliteTable('user_verbs', {
  name: text('name').primaryKey(),
  registeredAt: text('registered_at').notNull(),
});

// Execution ownership (engine/ownership): one row per engine operation —
// the atomic start reservation, the checkout guard, and the recovery
// ledger. DDL lives in open-state (engine-owned, idempotent); this is the
// typed shape queries use.
export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull(),
  kind: text('kind', { enum: ['start', 'continue', 'review', 'archive'] })
    .$type<'start' | 'continue' | 'review' | 'archive'>()
    .notNull(),
  owner: text('owner').notNull(),
  checkout: text('checkout').notNull(),
  state: text('state', {
    enum: ['reserved', 'active', 'recovery-required', 'completed', 'compensated'],
  })
    .$type<'reserved' | 'active' | 'recovery-required' | 'completed' | 'compensated'>()
    .notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type CardRow = typeof cards.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type SpecRow = typeof specs.$inferSelect;
export type IssueMapRow = typeof issueMap.$inferSelect;
export type PublishQueueRow = typeof publishQueue.$inferSelect;
export type UserVerbRow = typeof userVerbs.$inferSelect;
export type OperationRow = typeof operations.$inferSelect;

// --- E03 planning state (raw DDL in open-state.ts; typed shapes here) ------

// Immutable accepted-scope revisions per card: the digest covers canonical
// scope (identity + titles + order), never checkbox progress or render.
export const scopeRevisions = sqliteTable('scope_revisions', {
  cardId: text('card_id').notNull(),
  revision: integer('revision').notNull(),
  digest: text('digest').notNull(),
  operations: text('operations').notNull(), // JSON op summary for lineage
  createdAt: text('created_at').notNull(),
});

// Stable criterion identity per card. Legacy cards have no rows here —
// criterion identity stays `unclassified` until a reviewed edit supplies it.
export const scopeItems = sqliteTable('scope_items', {
  cardId: text('card_id').notNull(),
  id: text('id').notNull(),
  kind: text('kind', { enum: ['criterion'] }).$type<'criterion'>().notNull(),
  title: text('title').notNull(),
  state: text('state', { enum: ['active', 'removed', 'superseded'] })
    .$type<'active' | 'removed' | 'superseded'>()
    .notNull(),
  firstRevision: integer('first_revision').notNull(),
  lastRevision: integer('last_revision').notNull(),
});

// Epic intent: versioned parent constraints (optional — title-only is valid).
export const epicIntent = sqliteTable('epic_intent', {
  epicId: text('epic_id').primaryKey(),
  revision: integer('revision').notNull(),
  intent: text('intent').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Epic acceptance criteria with stable IDs; deferral is explicit.
export const epicCriteria = sqliteTable('epic_criteria', {
  epicId: text('epic_id').notNull(),
  id: text('id').notNull(),
  title: text('title').notNull(),
  state: text('state', { enum: ['active', 'deferred', 'removed'] })
    .$type<'active' | 'deferred' | 'removed'>()
    .notNull(),
  deferral: text('deferral'),
  firstRevision: integer('first_revision').notNull(),
});

// Coverage: a criterion is covered by one or more child VerbItems. Duplicate
// links are visible data, not silently collapsed.
export const epicCriterionLinks = sqliteTable('epic_criterion_links', {
  epicId: text('epic_id').notNull(),
  criterionId: text('criterion_id').notNull(),
  childId: text('child_id').notNull(),
  createdAt: text('created_at').notNull(),
});

// A child's acknowledgement of the parent revision it planned against.
export const childAcknowledgements = sqliteTable('child_acknowledgements', {
  cardId: text('card_id').primaryKey(),
  epicId: text('epic_id').notNull(),
  revision: integer('revision').notNull(),
  acknowledgedAt: text('acknowledged_at').notNull(),
});

// Same-project story dependency edges: card depends_on prerequisite.
export const storyDeps = sqliteTable('story_deps', {
  cardId: text('card_id').notNull(),
  dependsOn: text('depends_on').notNull(),
  createdAt: text('created_at').notNull(),
});

export type ScopeRevisionRow = typeof scopeRevisions.$inferSelect;
export type ScopeItemRow = typeof scopeItems.$inferSelect;
export type EpicIntentRow = typeof epicIntent.$inferSelect;
export type EpicCriterionRow = typeof epicCriteria.$inferSelect;
export type EpicCriterionLinkRow = typeof epicCriterionLinks.$inferSelect;
export type ChildAcknowledgementRow = typeof childAcknowledgements.$inferSelect;
export type StoryDepRow = typeof storyDeps.$inferSelect;

// --- E05 delivery/evidence state (raw DDL in open-state.ts; shapes here) -----

// Versioned per-card delivery/evidence policy. Absence = not enrolled: new
// scope defaults to team at enrollment; legacy scope stays unenrolled until
// an explicit migration choice.
export const deliveryPolicies = sqliteTable('delivery_policies', {
  cardId: text('card_id').primaryKey(),
  version: integer('version').notNull(),
  mode: text('mode', { enum: ['team', 'solo'] }).$type<'team' | 'solo'>().notNull(),
  requiredChecks: text('required_checks').notNull(), // JSON string[]
  requiredApprovals: integer('required_approvals').notNull(),
  manualCriteria: text('manual_criteria').notNull(), // JSON string[]
  enrolledAt: text('enrolled_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Append-only acceptance evidence (DECK-ARCH-012). Eligibility is computed by
// comparing each record's scope/policy/input identity against current state —
// records are never mutated or deleted, so completed history stays
// attributable after later changes.
export const evidenceRecords = sqliteTable('evidence_records', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull(),
  kind: text('kind', { enum: ['machine', 'manual'] }).$type<'machine' | 'manual'>().notNull(),
  criterionId: text('criterion_id'),
  taskId: text('task_id'),
  checkId: text('check_id'),
  command: text('command'),
  commandDigest: text('command_digest'),
  exitCode: integer('exit_code'),
  result: text('result', { enum: ['passed', 'failed', 'unavailable'] })
    .$type<'passed' | 'failed' | 'unavailable'>()
    .notNull(),
  producer: text('producer').notNull(),
  reviewer: text('reviewer'),
  rationale: text('rationale'),
  scopeRevision: integer('scope_revision').notNull(),
  policyVersion: integer('policy_version').notNull(),
  baseSha: text('base_sha').notNull(),
  headSha: text('head_sha').notNull(),
  inputFingerprint: text('input_fingerprint').notNull(),
  inputCoverage: text('input_coverage').notNull(), // JSON coverage report
  artifactPath: text('artifact_path'),
  artifactSha256: text('artifact_sha256'),
  artifactUnavailable: text('artifact_unavailable'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at').notNull(),
  recordedAt: text('recorded_at').notNull(),
});

// Durable provider intent ledger (DECK-ARCH-013): every issue/PR effect is
// recorded BEFORE the network call, reconciled after uncertain outcomes.
export const providerOperations = sqliteTable('provider_operations', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull(),
  kind: text('kind', { enum: ['issue-create', 'issue-edit', 'issue-close', 'pr-create', 'pr-update'] })
    .$type<'issue-create' | 'issue-edit' | 'issue-close' | 'pr-create' | 'pr-update'>()
    .notNull(),
  provider: text('provider').notNull(), // 'github'
  repo: text('repo').notNull(), // namespaced owner/name
  projectId: text('project_id').notNull(), // canonical project identity
  marker: text('marker').notNull(), // stable findable marker in generated content
  payloadRevision: integer('payload_revision').notNull(),
  payload: text('payload').notNull(), // JSON
  expectedHead: text('expected_head'),
  expectedBase: text('expected_base'),
  state: text('state', {
    enum: ['intented', 'claimed', 'succeeded', 'reconciled', 'uncertain', 'conflicted', 'failed', 'legacy-unobserved'],
  })
    .$type<
      | 'intented'
      | 'claimed'
      | 'succeeded'
      | 'reconciled'
      | 'uncertain'
      | 'conflicted'
      | 'failed'
      | 'legacy-unobserved'
    >()
    .notNull(),
  remoteId: text('remote_id'),
  remoteUrl: text('remote_url'),
  owner: text('owner'),
  error: text('error'),
  nextAction: text('next_action'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Delivery attempts (DECK-ARCH-014): preparation records, observed provider
// state at finalization and the uniquely-keyed completion.
export const deliveries = sqliteTable('deliveries', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull(),
  attempt: integer('attempt').notNull(),
  mode: text('mode', { enum: ['team', 'solo'] }).$type<'team' | 'solo'>().notNull(),
  policyVersion: integer('policy_version').notNull(),
  scopeRevision: integer('scope_revision').notNull(),
  inputFingerprint: text('input_fingerprint'),
  prNumber: integer('pr_number'),
  prUrl: text('pr_url'),
  headSha: text('head_sha'),
  baseBranch: text('base_branch'),
  mergeSha: text('merge_sha'),
  mergeMethod: text('merge_method'),
  deliveredSha: text('delivered_sha'),
  provenance: text('provenance', { enum: ['hosted', 'local'] }).$type<'hosted' | 'local'>(),
  state: text('state', { enum: ['prepared', 'pending', 'delivered', 'refused'] })
    .$type<'prepared' | 'pending' | 'delivered' | 'refused'>()
    .notNull(),
  refusalReason: text('refusal_reason'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Retryable post-delivery follow-ups; failures never undo recorded delivery.
export const cleanupTasks = sqliteTable('cleanup_tasks', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull(),
  deliveryId: text('delivery_id').notNull(),
  kind: text('kind', { enum: ['issue-close', 'branch-delete', 'changelog', 'release'] })
    .$type<'issue-close' | 'branch-delete' | 'changelog' | 'release'>()
    .notNull(),
  state: text('state', { enum: ['pending', 'done', 'failed'] }).$type<'pending' | 'done' | 'failed'>().notNull(),
  attempts: integer('attempts').notNull().default(0),
  identity: text('identity'),
  detail: text('detail'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type DeliveryPolicyRow = typeof deliveryPolicies.$inferSelect;
export type EvidenceRecordRow = typeof evidenceRecords.$inferSelect;
export type ProviderOperationRow = typeof providerOperations.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
export type CleanupTaskRow = typeof cleanupTasks.$inferSelect;

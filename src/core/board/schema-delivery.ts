import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const deliveryPolicies = sqliteTable('delivery_policies', {
  cardId: text('card_id').primaryKey(),
  version: integer('version').notNull(),
  mode: text('mode', { enum: ['team', 'solo'] }).$type<'team' | 'solo'>().notNull(),
  requiredChecks: text('required_checks').notNull(),
  requiredApprovals: integer('required_approvals').notNull(),
  manualCriteria: text('manual_criteria').notNull(),
  enrolledAt: text('enrolled_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

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
  inputCoverage: text('input_coverage').notNull(),
  artifactPath: text('artifact_path'),
  artifactSha256: text('artifact_sha256'),
  artifactUnavailable: text('artifact_unavailable'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at').notNull(),
  recordedAt: text('recorded_at').notNull(),
});

export const providerOperations = sqliteTable('provider_operations', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull(),
  kind: text('kind', {
    enum: ['issue-create', 'issue-edit', 'issue-close', 'pr-create', 'pr-update', 'branch-create', 'branch-push', 'integration', 'cleanup-close'],
  })
    .$type<
      | 'issue-create'
      | 'issue-edit'
      | 'issue-close'
      | 'pr-create'
      | 'pr-update'
      | 'branch-create'
      | 'branch-push'
      | 'integration'
      | 'cleanup-close'
    >()
    .notNull(),
  provider: text('provider').notNull(),
  repo: text('repo').notNull(),
  projectId: text('project_id').notNull(),
  marker: text('marker').notNull(),
  payloadRevision: integer('payload_revision').notNull(),
  payload: text('payload').notNull(),
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
  operationId: text('operation_id'),
  step: text('step'),
  expectedRef: text('expected_ref'),
  payloadDigest: text('payload_digest'),
  observedAt: text('observed_at'),
  tombstone: integer('tombstone').notNull().default(0),
});

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

// One controlled apply per accepted basis: binds the execution to the accepted
// spec revision, plan digest, impact basis, owner, checkout and input policy.
// The row is the coordination identity; the ownership operation row keeps
// fencing, leases and recovery semantics.
export const applyOperations = sqliteTable('apply_operations', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull(),
  acceptedRevision: integer('accepted_revision').notNull(),
  revisionId: text('revision_id').notNull(),
  planDigest: text('plan_digest').notNull(),
  impactBasis: text('impact_basis', {
    enum: ['approved-graph', 'approved-fallback', 'captured-unapproved', 'missing'],
  }).$type<'approved-graph' | 'approved-fallback' | 'captured-unapproved' | 'missing'>().notNull(),
  impactSnapshotId: text('impact_snapshot_id'),
  owner: text('owner').notNull(),
  checkout: text('checkout').notNull(),
  branch: text('branch'),
  headSha: text('head_sha'),
  dirtyPolicy: text('dirty_policy', { enum: ['allow', 'refuse'] }).$type<'allow' | 'refuse'>().notNull(),
  dependenciesReady: integer('dependencies_ready', { mode: 'boolean' }).notNull(),
  dependencyReport: text('dependency_report').notNull(),
  state: text('state', { enum: ['active', 'cancelled', 'completed'] })
    .$type<'active' | 'cancelled' | 'completed'>()
    .notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Durable checkpoint authority; Markdown checkpoint files are recoverable
// projections of these rows, never the sole source of truth.
export const checkpointRecords = sqliteTable('checkpoint_records', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull(),
  applyOperation: text('apply_operation'),
  scopeRevision: integer('scope_revision').notNull(),
  checkpointRevision: integer('checkpoint_revision').notNull(),
  digest: text('digest').notNull(),
  actor: text('actor').notNull(),
  kind: text('kind', { enum: ['decision', 'gotcha', 'remaining', 'blocker'] })
    .$type<'decision' | 'gotcha' | 'remaining' | 'blocker'>()
    .notNull(),
  text: text('text').notNull(),
  projection: text('projection', { enum: ['projected', 'pending', 'unknown'] })
    .$type<'projected' | 'pending' | 'unknown'>()
    .notNull(),
  createdAt: text('created_at').notNull(),
});

// Atomic evidence batch: one run identity carries every criterion/task link it
// satisfied, or none are eligible for completion.
export const evidenceRuns = sqliteTable('evidence_runs', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull(),
  scopeRevision: integer('scope_revision').notNull(),
  policyVersion: integer('policy_version').notNull(),
  applyOperation: text('apply_operation'),
  inputFingerprint: text('input_fingerprint').notNull(),
  producer: text('producer').notNull(),
  checkType: text('check_type', { enum: ['machine', 'manual'] }).$type<'machine' | 'manual'>().notNull(),
  checkId: text('check_id'),
  result: text('result', { enum: ['passed', 'failed', 'unavailable'] })
    .$type<'passed' | 'failed' | 'unavailable'>()
    .notNull(),
  payloadDigest: text('payload_digest').notNull(),
  artifacts: text('artifacts').notNull(),
  state: text('state', { enum: ['complete', 'incomplete'] }).$type<'complete' | 'incomplete'>().notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('evidence_runs_card_payload_unique').on(table.cardId, table.payloadDigest),
]);

export const evidenceRunLinks = sqliteTable('evidence_run_links', {
  runId: text('run_id').notNull(),
  criterionId: text('criterion_id'),
  taskId: text('task_id'),
}, (table) => [
  primaryKey({ columns: [table.runId, table.criterionId, table.taskId] }),
]);

// Local completion proof: recorded once the completion invariant holds, bound
// to the accepted revision and the delivery identity that finalized it.
export const completionRecords = sqliteTable('completion_records', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull(),
  applyOperation: text('apply_operation'),
  acceptedRevision: integer('accepted_revision').notNull(),
  revisionId: text('revision_id').notNull(),
  planDigest: text('plan_digest').notNull(),
  evidenceSummary: text('evidence_summary').notNull(),
  inputFingerprint: text('input_fingerprint').notNull(),
  deliveryId: text('delivery_id'),
  deliveryProvenance: text('delivery_provenance', { enum: ['hosted', 'local'] })
    .$type<'hosted' | 'local'>(),
  reviewState: text('review_state').notNull(),
  uncertainty: text('uncertainty').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('completion_card_revision_unique').on(table.cardId, table.acceptedRevision),
]);

export type DeliveryPolicyRow = typeof deliveryPolicies.$inferSelect;
export type EvidenceRecordRow = typeof evidenceRecords.$inferSelect;
export type ProviderOperationRow = typeof providerOperations.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
export type CleanupTaskRow = typeof cleanupTasks.$inferSelect;
export type ApplyOperationRow = typeof applyOperations.$inferSelect;
export type CheckpointRecordRow = typeof checkpointRecords.$inferSelect;
export type EvidenceRunRow = typeof evidenceRuns.$inferSelect;
export type EvidenceRunLinkRow = typeof evidenceRunLinks.$inferSelect;
export type CompletionRecordRow = typeof completionRecords.$inferSelect;

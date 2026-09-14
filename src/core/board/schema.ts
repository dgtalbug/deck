import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type { CardType, Lane, VerbName } from './types.ts';

export const cards = sqliteTable('cards', {
  id: text('id').primaryKey(),
  type: text('type', { enum: ['note', 'verb', 'tweak'] }).$type<CardType>().notNull(),
  title: text('title').notNull(),
  verb: text('verb').$type<VerbName | null>(),
  lane: text('lane', { enum: ['todo', 'groomed', 'active', 'verify', 'done'] }).$type<Lane>().notNull(),
  position: real('position').notNull(),
  specPath: text('spec_path'),
  requirement: text('requirement'),
  epicId: text('epic_id'),
  research: text('research'), 
  blockedReason: text('blocked_reason'),
  blockedAt: text('blocked_at'),
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

export const issueMap = sqliteTable('issue_map', {
  cardId: text('card_id').primaryKey(),
  issueNumber: integer('issue_number').notNull(),
  state: text('state', { enum: ['draft', 'open', 'closed'] }).$type<'draft' | 'open' | 'closed'>().notNull(),
  checksum: text('checksum').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const publishQueue = sqliteTable('publish_queue', {
  cardId: text('card_id').primaryKey(),
  checksum: text('checksum').notNull(),
  enqueuedAt: text('enqueued_at').notNull(),
});

export const userVerbs = sqliteTable('user_verbs', {
  name: text('name').primaryKey(),
  registeredAt: text('registered_at').notNull(),
});

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

export const scopeRevisions = sqliteTable('scope_revisions', {
  cardId: text('card_id').notNull(),
  revision: integer('revision').notNull(),
  digest: text('digest').notNull(),
  operations: text('operations').notNull(), 
  createdAt: text('created_at').notNull(),
});

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

export const epicIntent = sqliteTable('epic_intent', {
  epicId: text('epic_id').primaryKey(),
  revision: integer('revision').notNull(),
  intent: text('intent').notNull(),
  updatedAt: text('updated_at').notNull(),
});

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

export const epicCriterionLinks = sqliteTable('epic_criterion_links', {
  epicId: text('epic_id').notNull(),
  criterionId: text('criterion_id').notNull(),
  childId: text('child_id').notNull(),
  createdAt: text('created_at').notNull(),
});

export const childAcknowledgements = sqliteTable('child_acknowledgements', {
  cardId: text('card_id').primaryKey(),
  epicId: text('epic_id').notNull(),
  revision: integer('revision').notNull(),
  acknowledgedAt: text('acknowledged_at').notNull(),
});

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
  kind: text('kind', { enum: ['issue-create', 'issue-edit', 'issue-close', 'pr-create', 'pr-update'] })
    .$type<'issue-create' | 'issue-edit' | 'issue-close' | 'pr-create' | 'pr-update'>()
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

export const taskState = sqliteTable('task_state', {
  taskId: text('task_id').primaryKey(),
  cardId: text('card_id').notNull(),
  revision: integer('revision').notNull().default(1),
  owner: text('owner'),
  assignedAt: text('assigned_at'),
  updatedAt: text('updated_at').notNull(),
});

export const taskPatches = sqliteTable('task_patches', {
  commandId: text('command_id').primaryKey(),
  cardId: text('card_id').notNull(),
  taskId: text('task_id').notNull(),
  owner: text('owner').notNull(),
  expectedRevision: integer('expected_revision').notNull(),
  payloadDigest: text('payload_digest').notNull(),
  result: text('result').notNull(),
  createdAt: text('created_at').notNull(),
});

export const handoffs = sqliteTable('handoffs', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull(),
  taskId: text('task_id').notNull(),
  sender: text('sender').notNull(),
  recipient: text('recipient').notNull(),
  scopeRevision: integer('scope_revision').notNull(),
  checkpointRevision: integer('checkpoint_revision').notNull(),
  remainingWork: text('remaining_work'),
  evidenceIds: text('evidence_ids'),
  state: text('state', { enum: ['offered', 'accepted', 'cancelled'] })
    .$type<'offered' | 'accepted' | 'cancelled'>()
    .notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  closedAt: text('closed_at'),
});

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  projectPath: text('project_path').notNull(),
  path: text('path'),
  branch: text('branch').notNull(),
  expectedHead: text('expected_head'),
  state: text('state', {
    enum: ['creating', 'attached', 'recovery-required', 'detached'],
  })
    .$type<'creating' | 'attached' | 'recovery-required' | 'detached'>()
    .notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  closedAt: text('closed_at'),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;

export type TaskStateRow = typeof taskState.$inferSelect;
export type TaskPatchRow = typeof taskPatches.$inferSelect;
export type HandoffRow = typeof handoffs.$inferSelect;

export type DeliveryPolicyRow = typeof deliveryPolicies.$inferSelect;
export type EvidenceRecordRow = typeof evidenceRecords.$inferSelect;
export type ProviderOperationRow = typeof providerOperations.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
export type CleanupTaskRow = typeof cleanupTasks.$inferSelect;

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
  historyAt: text('history_at'),
  completedAt: text('completed_at'),
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
    // Accepted revision this render projects; NULL marks legacy unclassified
    // renders produced before accepted revisions existed.
    scopeRevision: integer('scope_revision'),
  },
  (table) => [primaryKey({ columns: [table.cardId, table.version] })],
);

export const issueMap = sqliteTable('issue_map', {
  cardId: text('card_id').primaryKey(),
  issueNumber: integer('issue_number').notNull(),
  state: text('state', { enum: ['draft', 'open', 'closed'] }).$type<'draft' | 'open' | 'closed'>().notNull(),
  checksum: text('checksum').notNull(),
  updatedAt: text('updated_at').notNull(),
  // Accepted revision the published body projected; NULL when the published
  // checksum no longer matches any accepted render.
  scopeRevision: integer('scope_revision'),
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
  leaseExpiresAt: text('lease_expires_at'),
  fenceToken: integer('fence_token').notNull().default(0),
});

export type CardRow = typeof cards.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type SpecRow = typeof specs.$inferSelect;
export type IssueMapRow = typeof issueMap.$inferSelect;
export type PublishQueueRow = typeof publishQueue.$inferSelect;
export type UserVerbRow = typeof userVerbs.$inferSelect;
export type OperationRow = typeof operations.$inferSelect;

// Task progress is addressed by composite (card_id, task_id): two stories may
// share a task id suffix or title without colliding.
export const taskState = sqliteTable(
  'task_state',
  {
    taskId: text('task_id').notNull(),
    cardId: text('card_id').notNull(),
    revision: integer('revision').notNull().default(1),
    owner: text('owner'),
    assignedAt: text('assigned_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.cardId, table.taskId] })],
);

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

export const sourceBaselines = sqliteTable('source_baselines', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull(),
  version: integer('version').notNull(),
  scopeRevision: integer('scope_revision').notNull(),
  path: text('path').notNull(),
  digest: text('digest').notNull(),
  snapshotPath: text('snapshot_path'),
  graphGeneration: integer('graph_generation'),
  graphFingerprint: text('graph_fingerprint'),
  createdAt: text('created_at').notNull(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type SourceBaselineRow = typeof sourceBaselines.$inferSelect;
export type TaskStateRow = typeof taskState.$inferSelect;
export type TaskPatchRow = typeof taskPatches.$inferSelect;
export type HandoffRow = typeof handoffs.$inferSelect;

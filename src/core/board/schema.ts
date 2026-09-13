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

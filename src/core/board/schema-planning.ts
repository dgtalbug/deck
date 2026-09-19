import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

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

// Canonical accepted scope: one immutable revision per accepted change, with
// full per-revision snapshots so any revision renders without replay.
export const specRevisions = sqliteTable('spec_revisions', {
  cardId: text('card_id').notNull(),
  revision: integer('revision').notNull(),
  revisionId: text('revision_id').notNull(),
  contentDigest: text('content_digest').notNull(),
  operations: text('operations').notNull(),
  actor: text('actor').notNull(),
  basisRevision: integer('basis_revision'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.cardId, table.revision] }),
]);

export const specRequirements = sqliteTable('spec_requirements', {
  cardId: text('card_id').notNull(),
  revision: integer('revision').notNull(),
  reqId: text('req_id').notNull(),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
}, (table) => [
  primaryKey({ columns: [table.cardId, table.revision, table.reqId] }),
]);

export const specCriteria = sqliteTable('spec_criteria', {
  cardId: text('card_id').notNull(),
  revision: integer('revision').notNull(),
  criterionId: text('criterion_id').notNull(),
  title: text('title').notNull(),
  state: text('state', { enum: ['active', 'removed', 'superseded'] })
    .$type<'active' | 'removed' | 'superseded'>()
    .notNull(),
}, (table) => [
  primaryKey({ columns: [table.cardId, table.revision, table.criterionId] }),
]);

export const specPlanItems = sqliteTable('spec_plan_items', {
  cardId: text('card_id').notNull(),
  revision: integer('revision').notNull(),
  taskId: text('task_id').notNull(),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  state: text('state', { enum: ['active', 'removed', 'superseded'] })
    .$type<'active' | 'removed' | 'superseded'>()
    .notNull(),
}, (table) => [
  primaryKey({ columns: [table.cardId, table.revision, table.taskId] }),
]);

export const scopeQuarantine = sqliteTable('scope_quarantine', {
  id: text('id').primaryKey(),
  cardId: text('card_id').notNull(),
  kind: text('kind').notNull(),
  detail: text('detail').notNull(),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
  resolution: text('resolution'),
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
export type SpecRevisionRow = typeof specRevisions.$inferSelect;
export type SpecRequirementRow = typeof specRequirements.$inferSelect;
export type SpecCriterionRow = typeof specCriteria.$inferSelect;
export type SpecPlanItemRow = typeof specPlanItems.$inferSelect;
export type ScopeQuarantineRow = typeof scopeQuarantine.$inferSelect;
export type EpicIntentRow = typeof epicIntent.$inferSelect;
export type EpicCriterionRow = typeof epicCriteria.$inferSelect;
export type EpicCriterionLinkRow = typeof epicCriterionLinks.$inferSelect;
export type ChildAcknowledgementRow = typeof childAcknowledgements.$inferSelect;
export type StoryDepRow = typeof storyDeps.$inferSelect;

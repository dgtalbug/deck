import {
  integer,
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

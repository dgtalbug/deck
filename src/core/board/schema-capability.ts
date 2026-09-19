import {
  integer,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const capabilityStatements = sqliteTable('capability_statements', {
  id: text('id').primaryKey(),
  capabilityId: text('capability_id').notNull(),
  statementId: text('statement_id').notNull(),
  version: integer('version').notNull(),
  text: text('text').notNull(),
  digest: text('digest').notNull(),
  sourceCardId: text('source_card_id').notNull(),
  sourceCriterionId: text('source_criterion_id').notNull(),
  sourceScopeRevision: integer('source_scope_revision').notNull(),
  evidenceId: text('evidence_id').notNull(),
  deliveryId: text('delivery_id').notNull(),
  state: text('state', { enum: ['current', 'removed'] }).$type<'current' | 'removed'>().notNull(),
  projectionVersionId: text('projection_version_id').notNull(),
  createdAt: text('created_at').notNull(),
});

export const capabilityPreviews = sqliteTable('capability_previews', {
  id: text('id').primaryKey(),
  batchId: text('batch_id').notNull(),
  baseDigest: text('base_digest').notNull(),
  sourceDigest: text('source_digest').notNull(),
  contentDigest: text('content_digest').notNull(),
  previewJson: text('preview_json').notNull(),
  state: text('state', { enum: ['previewed', 'accepted', 'stale', 'conflicted'] })
    .$type<'previewed' | 'accepted' | 'stale' | 'conflicted'>()
    .notNull(),
  createdAt: text('created_at').notNull(),
});

export const capabilityVersions = sqliteTable('capability_versions', {
  id: text('id').primaryKey(),
  version: integer('version').notNull(),
  baseDigest: text('base_digest').notNull(),
  contentDigest: text('content_digest').notNull(),
  previewId: text('preview_id').notNull(),
  acceptedBy: text('accepted_by').notNull(),
  rationale: text('rationale').notNull(),
  createdAt: text('created_at').notNull(),
});

export const capabilityDeltas = sqliteTable('capability_deltas', {
  id: text('id').primaryKey(),
  batchId: text('batch_id').notNull(),
  deltaId: text('delta_id').notNull(),
  op: text('op', { enum: ['add', 'modify', 'remove'] }).$type<'add' | 'modify' | 'remove'>().notNull(),
  capabilityId: text('capability_id').notNull(),
  statementId: text('statement_id').notNull(),
  statementDigest: text('statement_digest'),
  sourceCardId: text('source_card_id').notNull(),
  sourceCriterionId: text('source_criterion_id').notNull(),
  sourceScopeRevision: integer('source_scope_revision').notNull(),
  evidenceId: text('evidence_id').notNull(),
  deliveryId: text('delivery_id').notNull(),
  previewId: text('preview_id').notNull(),
  appliedVersionId: text('applied_version_id'),
  createdAt: text('created_at').notNull(),
});

export type CapabilityStatementRow = typeof capabilityStatements.$inferSelect;
export type CapabilityPreviewRow = typeof capabilityPreviews.$inferSelect;
export type CapabilityVersionRow = typeof capabilityVersions.$inferSelect;
export type CapabilityDeltaRow = typeof capabilityDeltas.$inferSelect;

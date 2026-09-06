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
// `state` is deck's last-observed open/closed of the issue.
export const issueMap = sqliteTable('issue_map', {
  cardId: text('card_id').primaryKey(),
  issueNumber: integer('issue_number').notNull(),
  state: text('state', { enum: ['open', 'closed'] }).$type<'open' | 'closed'>().notNull(),
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

export type CardRow = typeof cards.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type SpecRow = typeof specs.$inferSelect;
export type IssueMapRow = typeof issueMap.$inferSelect;
export type PublishQueueRow = typeof publishQueue.$inferSelect;
export type UserVerbRow = typeof userVerbs.$inferSelect;

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { BoardEventType } from './types.ts';

// The event outbox: every core mutation writes its event row in the SAME
// transaction, so any process can observe board changes durably and in order.
export const events = sqliteTable('events', {
  rowid: integer('rowid').primaryKey({ autoIncrement: true }),
  type: text('type').$type<BoardEventType>().notNull(),
  payload: text('payload').notNull(), // JSON
  createdAt: text('created_at').notNull(),
});

export type EventRow = typeof events.$inferSelect;

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { BoardEventType } from './types.ts';

export const events = sqliteTable('events', {
  rowid: integer('rowid').primaryKey({ autoIncrement: true }),
  type: text('type').$type<BoardEventType>().notNull(),
  payload: text('payload').notNull(), 
  createdAt: text('created_at').notNull(),
});

export type EventRow = typeof events.$inferSelect;

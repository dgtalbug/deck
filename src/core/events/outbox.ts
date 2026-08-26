import { asc, gt } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';
import { desc } from 'drizzle-orm';
import { events } from './schema.ts';
import type { BoardEvent, BoardEventPayload, BoardEventType } from './types.ts';

// Executor accepts either the db or a transaction callback parameter, so
// emits share the caller's transaction (the outbox atomicity contract).
export type Executor = SQLiteBunDatabase | Parameters<Parameters<SQLiteBunDatabase['transaction']>[0]>[0];

export function emitEvent(
  exec: Executor,
  type: BoardEventType,
  payload: BoardEventPayload,
): void {
  exec
    .insert(events)
    .values({ type, payload: JSON.stringify(payload), createdAt: new Date().toISOString() })
    .run();
}

export function readSince(exec: SQLiteBunDatabase, rowid: number): BoardEvent[] {
  return exec
    .select()
    .from(events)
    .where(gt(events.rowid, rowid))
    .orderBy(asc(events.rowid))
    .all()
    .map((row) => ({
      rowid: row.rowid,
      type: row.type,
      payload: JSON.parse(row.payload) as BoardEventPayload,
      createdAt: row.createdAt,
    }));
}

export function latestRowid(exec: SQLiteBunDatabase): number {
  const row = exec.select({ rowid: events.rowid }).from(events).orderBy(desc(events.rowid)).get();
  return row?.rowid ?? 0;
}

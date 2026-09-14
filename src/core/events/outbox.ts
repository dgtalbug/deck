import { asc, gt, sql } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';
import { desc } from 'drizzle-orm';
import { events } from './schema.ts';
import type { BoardEvent, BoardEventPayload, BoardEventType } from './types.ts';

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

// Bounded ordered tail read: at most `maxRows` rows per batch, with payload
// byte length projected in SQL so an oversized frame is detected without ever
// materializing its body. Events are never pruned here.
export const DELIVERY_BATCH_ROWS = 100;
export const FRAME_BYTE_LIMIT = 16 * 1024;

export interface BatchedTail {
  events: BoardEvent[];
  lastRowid: number;
  oversizedRowids: number[];
}

export function readSinceBatched(exec: SQLiteBunDatabase, rowid: number, maxRows = DELIVERY_BATCH_ROWS): BatchedTail {
  const rows = exec
    .select({
      rowid: events.rowid,
      type: events.type,
      payload: sql<string | null>`CASE WHEN length(${events.payload}) <= ${FRAME_BYTE_LIMIT} THEN ${events.payload} ELSE NULL END`,
      createdAt: events.createdAt,
      bytes: sql<number>`length(${events.payload})`,
    })
    .from(events)
    .where(gt(events.rowid, rowid))
    .orderBy(asc(events.rowid))
    .limit(maxRows + 1)
    .all();
  const bounded = rows.slice(0, maxRows);
  const oversizedRowids = bounded.filter((row) => row.bytes > FRAME_BYTE_LIMIT).map((row) => row.rowid);
  return {
    events: bounded
      .filter((row) => row.bytes <= FRAME_BYTE_LIMIT && row.payload !== null)
      .map((row) => ({
        rowid: row.rowid,
        type: row.type,
        payload: JSON.parse(row.payload!) as BoardEventPayload,
        createdAt: row.createdAt,
      })),
    lastRowid: bounded.length > 0 ? bounded[bounded.length - 1]!.rowid : rowid,
    oversizedRowids,
  };
}

export function latestRowid(exec: SQLiteBunDatabase): number {
  const row = exec.select({ rowid: events.rowid }).from(events).orderBy(desc(events.rowid)).get();
  return row?.rowid ?? 0;
}

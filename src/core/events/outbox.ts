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

export interface OversizedTombstone {
  kind: 'oversized';
  rowid: number;
  originalType: BoardEventType | 'unknown';
  byteSize: number;
  recoveryRef: string;
}

export type DeliveredEvent = BoardEvent | OversizedTombstone;

export interface BatchedTail {
  events: BoardEvent[];
  /** Oversized events in their original ordered positions, as bounded typed
   * tombstones — an invisible cursor gap never replaces a diagnosable one. */
  entries: DeliveredEvent[];
  lastRowid: number;
  oversizedRowids: number[];
}

export function isOversized(entry: DeliveredEvent): entry is OversizedTombstone {
  return (entry as OversizedTombstone).kind === 'oversized';
}

// Byte-correct sizing: length() on TEXT counts characters, so multibyte
// payloads are measured on their blob encoding.
export function readSinceBatched(exec: SQLiteBunDatabase, rowid: number, maxRows = DELIVERY_BATCH_ROWS): BatchedTail {
  const rows = exec
    .select({
      rowid: events.rowid,
      type: events.type,
      payload: sql<string | null>`CASE WHEN length(CAST(${events.payload} AS BLOB)) <= ${FRAME_BYTE_LIMIT} THEN ${events.payload} ELSE NULL END`,
      createdAt: events.createdAt,
      bytes: sql<number>`length(CAST(${events.payload} AS BLOB))`,
    })
    .from(events)
    .where(gt(events.rowid, rowid))
    .orderBy(asc(events.rowid))
    .limit(maxRows + 1)
    .all();
  const bounded = rows.slice(0, maxRows);
  const oversizedRowids = bounded.filter((row) => row.bytes > FRAME_BYTE_LIMIT).map((row) => row.rowid);
  const delivered: DeliveredEvent[] = bounded.map((row) =>
    row.payload === null
      ? {
          kind: 'oversized' as const,
          rowid: row.rowid,
          originalType: row.type ?? 'unknown',
          byteSize: row.bytes,
          recoveryRef: `events#${row.rowid} (${row.bytes} bytes exceeds the ${FRAME_BYTE_LIMIT}-byte frame limit; query the events table directly)`,
        }
      : {
          rowid: row.rowid,
          type: row.type,
          payload: JSON.parse(row.payload) as BoardEventPayload,
          createdAt: row.createdAt,
        },
  );
  return {
    events: delivered.filter((entry) => !isOversized(entry)) as BoardEvent[],
    entries: delivered,
    lastRowid: bounded.length > 0 ? bounded[bounded.length - 1]!.rowid : rowid,
    oversizedRowids,
  };
}

export class ResyncRequiredError extends Error {
  readonly consumer: string;
  readonly requestedFrom: number;
  readonly retainedFrom: number;
  constructor(consumer: string, requestedFrom: number, retainedFrom: number) {
    super(
      `consumer '${consumer}' requested replay from ${requestedFrom}, before retained history ` +
        `(${retainedFrom}) — explicit resynchronization required; history was pruned under the retention policy`,
    );
    this.name = 'ResyncRequiredError';
    this.consumer = consumer;
    this.requestedFrom = requestedFrom;
    this.retainedFrom = retainedFrom;
  }
}

export interface ConsumerRow {
  name: string;
  position: number;
  retiredAt: string | null;
}

function ensureConsumerTables(exec: SQLiteBunDatabase): void {
  exec.run(sql`CREATE TABLE IF NOT EXISTS event_consumers (
    name TEXT PRIMARY KEY NOT NULL, position INTEGER NOT NULL,
    registered_at TEXT NOT NULL, updated_at TEXT NOT NULL, retired_at TEXT)`);
  exec.run(sql`CREATE TABLE IF NOT EXISTS event_acks (
    consumer TEXT NOT NULL, rowid INTEGER NOT NULL, acked_at TEXT NOT NULL,
    PRIMARY KEY (consumer, rowid))`);
}

// Consumers start at an explicit position — never inferred from the current
// maximum, which would silently skip history.
export function registerConsumer(
  exec: SQLiteBunDatabase,
  name: string,
  at: { from: 'beginning' | 'end' } | { from: 'rowid'; rowid: number },
): ConsumerRow {
  ensureConsumerTables(exec);
  const start = at.from === 'beginning' ? 0 : at.from === 'end' ? latestRowid(exec) : at.from === 'rowid' ? at.rowid : 0;
  const ts = new Date().toISOString();
  exec.run(
    sql`INSERT INTO event_consumers (name, position, registered_at, updated_at)
        VALUES (${name}, ${start}, ${ts}, ${ts})
        ON CONFLICT(name) DO NOTHING`,
  );
  const rows = exec.all(sql`SELECT name, position, retired_at AS "retiredAt" FROM event_consumers WHERE name = ${name}`) as unknown as Array<ConsumerRow>;
  return rows[0]!;
}

export function getConsumer(exec: SQLiteBunDatabase, name: string): ConsumerRow | null {
  ensureConsumerTables(exec);
  const rows = exec.all(sql`SELECT name, position, retired_at AS "retiredAt" FROM event_consumers WHERE name = ${name}`) as unknown as Array<ConsumerRow>;
  return rows[0] ?? null;
}

// Acknowledgement is conditional and ordered: position advances only across a
// contiguous prefix, so gaps are impossible and a crash before ack replays
// the same stable rowid.
export function acknowledge(exec: SQLiteBunDatabase, consumer: string, rowid: number): ConsumerRow {
  ensureConsumerTables(exec);
  const current = getConsumer(exec, consumer);
  if (current === null) throw new Error(`consumer '${consumer}' is not registered`);
  if (current.retiredAt !== null) throw new Error(`consumer '${consumer}' is retired — re-register explicitly`);
  // Ordered means "the next pending rowid", not "position + 1": logs may not
  // start at 1 and pruned history leaves gaps.
  const nextRows = exec.all(sql`SELECT MIN(rowid) AS next FROM events WHERE rowid > ${current.position}`) as unknown as Array<{ next: number | null }>;
  const next = nextRows[0]?.next ?? null;
  if (next === null || rowid !== next) {
    throw new Error(
      `out-of-order acknowledgement: consumer '${consumer}' is at ${current.position} ` +
        `(next pending rowid is ${next ?? 'none'}), refusing ack for ${rowid} ` +
        `(acks advance one committed event at a time)`,
    );
  }
  const ts = new Date().toISOString();
  exec.run(sql`INSERT INTO event_acks (consumer, rowid, acked_at) VALUES (${consumer}, ${rowid}, ${ts})
               ON CONFLICT(consumer, rowid) DO NOTHING`);
  exec.run(sql`UPDATE event_consumers SET position = ${rowid}, updated_at = ${ts} WHERE name = ${consumer}`);
  return { ...current, position: rowid };
}

// Read after the consumer's position, tombstones included at their ordered
// positions; a tombstone must be explicitly processed before its ack.
export function pendingFor(exec: SQLiteBunDatabase, consumer: string, maxRows = DELIVERY_BATCH_ROWS): DeliveredEvent[] {
  const current = getConsumer(exec, consumer);
  if (current === null) throw new Error(`consumer '${consumer}' is not registered`);
  return readSinceBatched(exec, current.position, maxRows).entries;
}

export function retireConsumer(exec: SQLiteBunDatabase, consumer: string): void {
  ensureConsumerTables(exec);
  const ts = new Date().toISOString();
  exec.run(sql`UPDATE event_consumers SET retired_at = ${ts}, updated_at = ${ts} WHERE name = ${consumer}`);
}

// Retention prunes only below every non-retired consumer position AND the
// configured replay window; a lagging consumer blocks pruning until it
// advances or is explicitly retired.
export function pruneEvents(
  exec: SQLiteBunDatabase,
  options: { replayWindow: number; keepMinimum?: number },
): { pruned: number; blockedBy: string[] } {
  ensureConsumerTables(exec);
  const newest = latestRowid(exec);
  const floor = newest - options.replayWindow;
  const consumers = exec.all(sql`SELECT name, position, retired_at AS "retiredAt" FROM event_consumers`) as unknown as Array<ConsumerRow>;
  const active = consumers.filter((row) => row.retiredAt === null);
  const blocking = active.filter((row) => row.position < floor).map((row) => row.name);
  if (blocking.length > 0) {
    return { pruned: 0, blockedBy: blocking };
  }
  const cutoff = Math.min(floor, ...active.map((row) => row.position), newest - (options.keepMinimum ?? 0));
  if (cutoff <= 0) return { pruned: 0, blockedBy: [] };
  exec.run(sql`DELETE FROM events WHERE rowid <= ${cutoff}`);
  exec.run(sql`INSERT INTO deck_meta (key, value) VALUES ('events_pruned_through', ${String(cutoff)})
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  return { pruned: cutoff, blockedBy: [] };
}

// Replay from an explicit position; before retained history this refuses
// with a typed resync-required result instead of skipping ahead.
export function replayFrom(exec: SQLiteBunDatabase, consumer: string, from: number, maxRows = DELIVERY_BATCH_ROWS): DeliveredEvent[] {
  const oldest = (exec.all(sql`SELECT MIN(rowid) AS oldest FROM events`) as unknown as Array<{ oldest: number | null }>)[0]?.oldest ?? null;
  if (oldest !== null && from < oldest - 1) {
    throw new ResyncRequiredError(consumer, from, oldest - 1);
  }
  if (oldest === null) {
    // History exists only as a pruned marker: replay from before it cannot
    // be satisfied.
    const prunedRows = exec.all(sql`SELECT value FROM deck_meta WHERE key = 'events_pruned_through'`) as unknown as Array<{ value: string }>;
    const pruned = prunedRows[0] !== undefined ? Number.parseInt(prunedRows[0]!.value, 10) : null;
    if (pruned !== null && !Number.isNaN(pruned)) {
      throw new ResyncRequiredError(consumer, from, pruned);
    }
  }
  return readSinceBatched(exec, from, maxRows).entries;
}

export function latestRowid(exec: SQLiteBunDatabase): number {
  const row = exec.select({ rowid: events.rowid }).from(events).orderBy(desc(events.rowid)).get();
  return row?.rowid ?? 0;
}

import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { cards, cleanupTasks, deliveries, epicCriteria, epicCriterionLinks, operations, tasks } from './schema.ts';
import type { DocumentStore } from './store.ts';
import { runTx } from './store.ts';
import { emitEvent } from '../events/outbox.ts';

// Live retention: completed work rotates into retained, browsable history
// above 100 combined live epics/stories or 500 task rows on live stories.
// Exactly at either threshold nothing rotates; unfinished work is never
// hidden to satisfy a cap — excess unfinished work is reported as overflow.
export const LIVE_RECORD_LIMIT = 100;
export const LIVE_TASK_LIMIT = 500;

export interface LiveCounts {
  records: number;
  tasks: number;
}

export function liveCounts(store: DocumentStore): LiveCounts {
  const records = store.db
    .select({ count: sql<number>`count(*)` })
    .from(cards)
    .where(and(isNull(cards.historyAt), or(eq(cards.type, 'epic'), eq(cards.type, 'verb'))))
    .get();
  const taskCount = store.db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(cards, and(eq(cards.id, tasks.cardId), eq(cards.type, 'verb'), isNull(cards.historyAt)))
    .get();
  return { records: records?.count ?? 0, tasks: taskCount?.count ?? 0 };
}

interface CandidateRow {
  id: string;
  completedAt: string | null;
  updatedAt: string;
}

function eligibleDoneStories(store: DocumentStore): CandidateRow[] {
  return store.db
    .select({ id: cards.id, completedAt: cards.completedAt, updatedAt: cards.updatedAt })
    .from(cards)
    .where(and(eq(cards.lane, 'done'), eq(cards.type, 'verb'), isNull(cards.historyAt)))
    .all()
    .filter((row) => !hasInFlightOperation(store, row.id) && !hasPendingCleanup(store, row.id));
}

function hasInFlightOperation(store: DocumentStore, cardId: string): boolean {
  const row = store.db
    .select({ id: operations.id })
    .from(operations)
    .where(and(eq(operations.cardId, cardId), inArray(operations.state, ['reserved', 'active', 'recovery-required'])))
    .get();
  return row !== undefined;
}

function hasPendingCleanup(store: DocumentStore, cardId: string): boolean {
  const row = store.db
    .select({ id: cleanupTasks.id })
    .from(cleanupTasks)
    .innerJoin(deliveries, eq(deliveries.id, cleanupTasks.deliveryId))
    .where(and(eq(deliveries.cardId, cardId), inArray(cleanupTasks.state, ['pending', 'failed'])))
    .get();
  return row !== undefined;
}

// Epics rotate only with at least one child, every child already historical,
// and no unresolved active acceptance criterion. Empty epics never infer
// completion from absence.
function eligibleEpics(store: DocumentStore): string[] {
  const epics = store.db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.type, 'epic'), isNull(cards.historyAt)))
    .all();
  const result: string[] = [];
  for (const epic of epics) {
    const children = store.db
      .select({ id: cards.id, historyAt: cards.historyAt })
      .from(cards)
      .where(and(eq(cards.epicId, epic.id), isNotNull(cards.id)))
      .all();
    if (children.length === 0) continue;
    if (!children.every((child) => child.historyAt !== null)) continue;
    const unresolved = store.db
      .select({ id: epicCriteria.id })
      .from(epicCriteria)
      .leftJoin(epicCriterionLinks, eq(epicCriterionLinks.criterionId, epicCriteria.id))
      .where(and(eq(epicCriteria.epicId, epic.id), eq(epicCriteria.state, 'active'), isNull(epicCriterionLinks.childId)))
      .get();
    if (unresolved !== undefined) continue;
    result.push(epic.id);
  }
  return result;
}

export interface RetentionSelection {
  archiveStories: string[];
  archiveEpics: string[];
  counts: LiveCounts;
  overflow: 'records' | 'tasks' | null;
}

// Pure selection: oldest eligible completed stories first (completion time,
// falling back to updatedAt for migrated records, then stable ID) until both
// limits are satisfied or no eligible work remains.
export function retentionSelection(store: DocumentStore): RetentionSelection {
  const counts = liveCounts(store);
  const overRecords = counts.records > LIVE_RECORD_LIMIT;
  const overTasks = counts.tasks > LIVE_TASK_LIMIT;
  if (!overRecords && !overTasks) {
    return { archiveStories: [], archiveEpics: eligibleEpics(store), counts, overflow: null };
  }

  const eligible = eligibleDoneStories(store).sort((a, b) => {
    const key = (row: CandidateRow) => row.completedAt ?? row.updatedAt;
    const diff = key(a).localeCompare(key(b));
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

  // Task accounting per candidate story, computed once.
  const taskCount = new Map<string, number>();
  for (const row of eligible) {
    const count = store.db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(eq(tasks.cardId, row.id))
      .get();
    taskCount.set(row.id, count?.count ?? 0);
  }

  const archiveStories: string[] = [];
  let records = counts.records;
  let taskRows = counts.tasks;
  for (const row of eligible) {
    if (records <= LIVE_RECORD_LIMIT && taskRows <= LIVE_TASK_LIMIT) break;
    archiveStories.push(row.id);
    records -= 1;
    taskRows -= taskCount.get(row.id) ?? 0;
  }

  const overflow = (overRecords && records > LIVE_RECORD_LIMIT) || (overTasks && taskRows > LIVE_TASK_LIMIT)
    ? overRecords && records > LIVE_RECORD_LIMIT ? 'records' : 'tasks'
    : null;
  return { archiveStories, archiveEpics: eligibleEpics(store), counts: { records, tasks: taskRows }, overflow };
}

export interface RetentionResult extends RetentionSelection {
  archived: string[];
}

// runRetention persists its outcome so the overflow status stays observable
// without re-running selection on reads.
export function runRetention(store: DocumentStore): RetentionResult {
  const selection = retentionSelection(store);
  const archived: string[] = [];
  if (selection.archiveStories.length > 0 || selection.archiveEpics.length > 0) {
    runTx(store.db, (tx) => {
      const at = new Date().toISOString();
      if (selection.archiveStories.length > 0) {
        tx.update(cards).set({ historyAt: at }).where(inArray(cards.id, selection.archiveStories)).run();
        archived.push(...selection.archiveStories);
      }
      // Epics selected above were already eligible (all children historical
      // at selection time); archiving stories cannot invalidate that.
      if (selection.archiveEpics.length > 0) {
        tx.update(cards).set({ historyAt: at }).where(inArray(cards.id, selection.archiveEpics)).run();
        archived.push(...selection.archiveEpics);
      }
      emitEvent(tx, 'card.updated', { id: archived[0] ?? '' });
    });
  }
  const status = JSON.stringify({ records: selection.counts.records, tasks: selection.counts.tasks, overflow: selection.overflow });
  store.raw()
    .query(
      `INSERT INTO deck_meta (key, value) VALUES ('retention_status', ?) ` +
        `ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(status);
  return { ...selection, archived };
}

export function retentionStatus(store: DocumentStore): { records: number; tasks: number; overflow: string | null } {
  const row = store.raw().query("SELECT value FROM deck_meta WHERE key = 'retention_status'").get() as { value: string } | null;
  if (row === null) return { records: 0, tasks: 0, overflow: null };
  return JSON.parse(row.value) as { records: number; tasks: number; overflow: string | null };
}

// Authorized reopen boundary: leaving done (or any edit that revives work)
// unhides the card and its parent epic atomically; dependency review
// semantics re-evaluate on the next planning read.
export function unhideWithParent(store: DocumentStore, cardId: string): void {
  const card = store.db.select({ epicId: cards.epicId }).from(cards).where(eq(cards.id, cardId)).get();
  if (card === undefined) return;
  runTx(store.db, (tx) => {
    tx.update(cards).set({ historyAt: null }).where(eq(cards.id, cardId)).run();
    if (card.epicId !== null) {
      tx.update(cards).set({ historyAt: null }).where(eq(cards.id, card.epicId)).run();
    }
  });
}

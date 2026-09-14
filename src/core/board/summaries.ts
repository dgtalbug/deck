import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { cards, tasks } from './schema.ts';
import type { DocumentStore } from './store.ts';
import type { Lane } from './types.ts';
import { latestRowid } from '../events/outbox.ts';
import { retentionStatus } from './history.ts';

// Bounded live/history summary pages. Summaries omit task bodies and spec
// text; the legacy full-board response remains the compatibility path and
// carries no bounded-payload guarantee. Every page and its totals are read in
// one SQLite transaction; cursors bind project, view, filters and the read
// revision so concurrent edits surface as an explicit stale conflict.
export const DEFAULT_PAGE = 25;
export const MAX_PAGE = 50;
export const ITEM_BYTE_CAP = 2048;
export const RESPONSE_BYTE_CAP = 131072;

export type SummaryView = 'live' | 'history';

export interface SummaryItem {
  id: string;
  type: 'note' | 'verb' | 'tweak' | 'epic';
  title: string;
  truncated: boolean;
  lane: Lane;
  position: number;
  verb: string | null;
  epicId: string | null;
  blocked: boolean;
  taskCounts: { done: number; total: number } | null;
  historyAt: string | null;
}

export interface SummaryCursor {
  view: SummaryView;
  project: string;
  lane?: Lane | undefined;
  rev: number;
  order: string;
  after?: [string, string] | undefined;
}

export interface SummaryPage {
  view: SummaryView;
  items: SummaryItem[];
  total: number;
  page_count: number;
  cursor: string | null;
  stale: boolean;
  revision: number;
  oversize: boolean;
  overflow: { records: number; tasks: number; overflow: string | null } | null;
}

export function readRevision(store: DocumentStore): number {
  // The outbox rowid is a monotonic counter already maintained atomically by
  // every relevant board write; it serves as the project read revision.
  return latestRowid(store.db);
}

function encodeCursor(cursor: SummaryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64');
}

export function decodeCursor(encoded: string): SummaryCursor {
  const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as SummaryCursor;
  if (parsed.view !== 'live' && parsed.view !== 'history') throw new Error('cursor has no view binding');
  if (typeof parsed.project !== 'string' || parsed.project.length === 0) throw new Error('cursor has no project binding');
  if (typeof parsed.rev !== 'number') throw new Error('cursor has no revision binding');
  return parsed;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  return Math.min(limit, MAX_PAGE);
}

function truncateTitle(title: string): { title: string; truncated: boolean } {
  const bytes = Buffer.byteLength(title, 'utf8');
  if (bytes <= 256) return { title, truncated: false };
  let cut = 240;
  while (cut > 0 && Buffer.byteLength(title.slice(0, cut), 'utf8') > 256) cut -= 1;
  return { title: `${title.slice(0, cut)}…`, truncated: true };
}

export function summaryPage(
  store: DocumentStore,
  options: { view?: SummaryView; lane?: Lane; limit?: number; cursor?: string },
): SummaryPage {
  const view: SummaryView = options.view ?? 'live';
  const limit = clampLimit(options.limit);
  const revision = readRevision(store);

  if (options.cursor !== undefined) {
    const cursor = decodeCursor(options.cursor);
    if (cursor.project !== store.projectPath) throw new Error('cursor belongs to a different project');
    if (cursor.view !== view || (cursor.lane ?? undefined) !== options.lane) throw new Error('cursor does not match this view or filter');
    if (cursor.order !== orderKey(view)) throw new Error('cursor order binding mismatch');
    if (cursor.rev !== revision) {
      return { view, items: [], total: 0, page_count: 0, cursor: null, stale: true, revision, oversize: false, overflow: null };
    }
    return page(store, view, options.lane, limit, revision, cursor.after);
  }
  return page(store, view, options.lane, limit, revision, undefined);
}

function orderKey(view: SummaryView): string {
  return view === 'history' ? 'historyAt,id' : 'position,id';
}

function page(
  store: DocumentStore,
  view: SummaryView,
  lane: Lane | undefined,
  limit: number,
  revision: number,
  after: [string, string] | undefined,
): SummaryPage {
  // One read transaction covers the page, its totals and the task counts.
  return store.db.transaction((tx) => {
    const baseFilter = and(
      view === 'history' ? isNotNull(cards.historyAt) : isNull(cards.historyAt),
      lane !== undefined ? eq(cards.lane, lane) : undefined,
    );
    // Live pages key on (position, id) ascending; history pages key on
    // (historyAt, id) descending — newest history first.
    const key = view === 'history' ? cards.historyAt : cards.position;
    const keyset =
      after !== undefined
        ? view === 'history'
          ? or(lt(key, after[0]), and(eq(key, after[0]), lt(cards.id, after[1])))
          : or(gt(key, after[0]), and(eq(key, after[0]), gt(cards.id, after[1])))
        : undefined;

    const rows = tx
      .select({
        id: cards.id,
        type: cards.type,
        title: cards.title,
        lane: cards.lane,
        position: cards.position,
        verb: cards.verb,
        epicId: cards.epicId,
        blockedReason: cards.blockedReason,
        historyAt: cards.historyAt,
      })
      .from(cards)
      .where(keyset !== undefined ? and(baseFilter, keyset) : baseFilter)
      .orderBy(view === 'history' ? desc(key) : asc(key), view === 'history' ? desc(cards.id) : asc(cards.id))
      .limit(limit)
      .all();

    const totalRow = tx.select({ count: sql<number>`count(*)` }).from(cards).where(baseFilter).get();

    const taskRows =
      rows.length === 0
        ? []
        : tx
            .select({
              cardId: tasks.cardId,
              done: sql<number>`sum(case when ${tasks.done} then 1 else 0 end)`,
              total: sql<number>`count(*)`,
            })
            .from(tasks)
            .where(
              sql`${tasks.cardId} IN (${sql.join(
                rows.map((row) => sql`${row.id}`),
                sql`, `,
              )})`,
            )
            .groupBy(tasks.cardId)
            .all();
    const counts = new Map(taskRows.map((row) => [row.cardId, { done: row.done, total: row.total }]));

    let items: SummaryItem[] = rows.map((row) => {
      const { title, truncated } = truncateTitle(row.title);
      return {
        id: row.id,
        type: row.type,
        title,
        truncated,
        lane: row.lane,
        position: row.position,
        verb: row.verb,
        epicId: row.epicId,
        blocked: row.blockedReason !== null,
        taskCounts: row.type === 'verb' ? (counts.get(row.id) ?? { done: 0, total: 0 }) : null,
        historyAt: row.historyAt,
      };
    });

    // 2 KiB per item, 128 KiB per response — both always apply; oversized
    // content shrinks the page instead of escaping the cap.
    let oversize = false;
    while (items.length > 0 && items.some((item) => Buffer.byteLength(JSON.stringify(item), 'utf8') > ITEM_BYTE_CAP)) {
      oversize = true;
      items = items.slice(0, -1);
    }
    while (items.length > 0 && Buffer.byteLength(JSON.stringify(items), 'utf8') > RESPONSE_BYTE_CAP) {
      oversize = true;
      items = items.slice(0, -1);
    }

    const hasMore = rows.length === limit;
    const last = items.at(-1);
    const cursor =
      hasMore && last !== undefined
        ? encodeCursor({
            view,
            project: store.projectPath,
            ...(lane !== undefined ? { lane } : {}),
            rev: revision,
            order: orderKey(view),
            after: [view === 'history' ? (last.historyAt ?? '') : String(last.position), last.id],
          })
        : null;

    return { view, items, total: totalRow?.count ?? 0, page_count: items.length, cursor, stale: false, revision, oversize, ...(view === 'history' ? { overflow: retentionStatus(store) } : { overflow: null }) };
  }) as SummaryPage;
}

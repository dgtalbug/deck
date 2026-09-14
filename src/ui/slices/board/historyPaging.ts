import type { SummaryItem, SummaryPageResult } from './api.ts';

// Client-side paging state for history summaries: pages append with
// id-deduplication, and a stale-cursor conflict (409) restarts the traversal
// from the first page rather than skipping or duplicating records.
export interface HistoryState {
  items: SummaryItem[];
  cursor: string | null;
  total: number;
  restarts: number;
  overflow: SummaryPageResult['overflow'];
}

export const emptyHistory: HistoryState = { items: [], cursor: null, total: 0, restarts: 0, overflow: null };

export function appendPage(state: HistoryState, page: SummaryPageResult): HistoryState {
  if (page.stale) {
    // the server reports a revision change; restart from scratch
    return { items: [], cursor: null, total: page.total, restarts: state.restarts + 1, overflow: page.overflow };
  }
  const seen = new Set(state.items.map((item) => item.id));
  const merged = [...state.items, ...page.items.filter((item) => !seen.has(item.id))];
  return { items: merged, cursor: page.cursor, total: page.total, restarts: state.restarts, overflow: page.overflow };
}

export async function loadMore(
  fetchPage: (cursor?: string) => Promise<SummaryPageResult>,
  state: HistoryState,
  restarting = false,
): Promise<HistoryState> {
  const cursor = restarting ? undefined : state.cursor ?? undefined;
  const page = await fetchPage(cursor);
  if (page.stale && !restarting) {
    // one explicit restart; a second consecutive conflict propagates as-is
    const fresh = await loadMore(fetchPage, emptyHistory, true);
    return { ...fresh, restarts: state.restarts + 1 };
  }
  return appendPage(restarting ? emptyHistory : state, page);
}

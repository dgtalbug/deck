import { describe, expect, test } from 'bun:test';
import { appendPage, emptyHistory, loadMore } from '../../src/ui/slices/board/historyPaging.ts';
import type { SummaryItem, SummaryPageResult } from '../../src/ui/slices/board/api.ts';

function item(id: string): SummaryItem {
  return {
    id, type: 'verb', title: `story ${id}`, truncated: false, lane: 'done', position: 0,
    verb: 'feat', epicId: null, blocked: false, taskCounts: { done: 2, total: 2 }, historyAt: '2026-09-14T00:00:00Z',
  };
}

function page(over: Partial<SummaryPageResult>): SummaryPageResult {
  return { view: 'history', items: [], total: 0, page_count: 0, cursor: null, stale: false, revision: 7, oversize: false, overflow: null, ...over };
}

describe('history paging state', () => {
  test('pages append with totals distinguished from shown counts', () => {
    const first = appendPage(emptyHistory, page({ items: [item('a'), item('b')], total: 5, page_count: 2, cursor: 'c1' }));
    const second = appendPage(first, page({ items: [item('c')], total: 5, page_count: 1, cursor: null }));
    expect(second.items.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(second.total).toBe(5);
    expect(second.cursor).toBe(null);
  });

  test('duplicate ids from a concurrent reorder never double-render', () => {
    const first = appendPage(emptyHistory, page({ items: [item('a'), item('b')], total: 3, cursor: 'c1' }));
    const overlapping = appendPage(first, page({ items: [item('b'), item('c')], total: 3 }));
    expect(overlapping.items.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  test('a stale page resets the traversal and counts one restart', () => {
    const first = appendPage(emptyHistory, page({ items: [item('a')], total: 3, cursor: 'c1' }));
    const stale = appendPage(first, page({ stale: true, revision: 9 }));
    expect(stale.items).toEqual([]);
    expect(stale.restarts).toBe(1);
  });

  test('loadMore restarts from the first page on a stale cursor', async () => {
    const first = appendPage(emptyHistory, page({ items: [item('a')], total: 3, cursor: 'c1', revision: 7 }));
    const calls: Array<string | undefined> = [];
    const fetchPage = async (cursor?: string): Promise<SummaryPageResult> => {
      calls.push(cursor);
      if (cursor === 'c1') return page({ stale: true, revision: 9 });
      return page({ items: [item('x'), item('y')], total: 2, cursor: null, revision: 9 });
    };
    const result = await loadMore(fetchPage, first);
    expect(calls).toEqual(['c1', undefined]); // restart from scratch
    expect(result.items.map((entry) => entry.id)).toEqual(['x', 'y']);
    expect(result.restarts).toBe(1);
  });

  test('loadMore passes the cursor forward on a healthy page', async () => {
    const first = appendPage(emptyHistory, page({ items: [item('a')], total: 3, cursor: 'c1' }));
    const fetchPage = async (cursor?: string): Promise<SummaryPageResult> => {
      expect(cursor).toBe('c1');
      return page({ items: [item('b')], total: 3, cursor: null });
    };
    const result = await loadMore(fetchPage, first);
    expect(result.items.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(result.restarts).toBe(0);
  });
});

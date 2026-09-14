import { useEffect, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { AlertTriangle, Archive, ChevronRight } from 'lucide-preact';
import type { BoardApi, SummaryItem } from './api.ts';
import { emptyHistory, loadMore, type HistoryState } from './historyPaging.ts';

const PAGE = 25;

function typeLabel(item: SummaryItem): string {
  if (item.type === 'epic') return 'epic';
  if (item.type === 'note') return 'note';
  return item.verb ?? 'story';
}

// Retained completed work: paged history summaries with full-detail links.
// Unfinished overflow is reported, never hidden — the live board keeps it.
export function HistoryView({ project, api }: { project: string; api: BoardApi }): VNode {
  const [state, setState] = useState<HistoryState>(emptyHistory);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = (cursor?: string) => {
    const fn = api.fetchHistorySummary;
    if (fn === undefined) throw new Error('history summaries unavailable — update the deck server');
    return fn(project, PAGE, cursor);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadMore(fetchPage, emptyHistory)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'history unavailable');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const more = async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await loadMore(fetchPage, state));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'history unavailable');
    } finally {
      setLoading(false);
    }
  };

  const overflow = state.overflow;
  return (
    <div class="history-view">
      <p class="subtitle">
        Completed work retained by the board — visibility only; reopening follows the engine workflow.
      </p>
      {overflow !== null && overflow.overflow !== null ? (
        <div class="callout c-warn banner" data-testid="history-overflow">
          <AlertTriangle size={15} />
          <div>
            <strong class="label">retention overflow (unfinished work stays live)</strong>
            {overflow.overflow === 'records' ? `${overflow.records} live records` : `${overflow.tasks} live task rows`} exceed the soft limit — finish or split work to bring the board back under it.
          </div>
        </div>
      ) : null}
      {error !== null ? <div class="callout c-warn banner">{error}</div> : null}
      {state.items.length === 0 && !loading && error === null ? (
        <div class="callout banner" role="status">no retained history yet — completed work appears here when the board crosses its live limits</div>
      ) : null}
      <ul class="history-list" role="list">
        {state.items.map((item) => (
          <li key={item.id} class="history-item">
            <Archive size={13} />
            <a class="history-link" href={`/${project}/?view=history&card=${encodeURIComponent(item.id)}`}>
              <span class="history-title">{item.title}</span>
              {item.truncated ? <span class="dim"> (title truncated)</span> : null}
            </a>
            <span class="dim">{typeLabel(item)}</span>
            {item.taskCounts !== null ? <span class="dim">{item.taskCounts.done}/{item.taskCounts.total} tasks</span> : null}
            <span class="dim">{item.historyAt !== null ? item.historyAt.slice(0, 10) : ''}</span>
            <ChevronRight size={13} />
          </li>
        ))}
      </ul>
      <div class="history-footer">
        <span class="dim">
          {state.items.length} of {state.total} shown{state.restarts > 0 ? ` · restarted ${state.restarts}× after concurrent edits` : ''}
        </span>
        {state.cursor !== null ? (
          <button type="button" class="btn btn-outline" onClick={more} disabled={loading} data-testid="history-more">
            {loading ? 'loading…' : 'load more'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

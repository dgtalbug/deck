import { useCallback, useEffect, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { Clock, GitPullRequest, RefreshCw, Target, Zap } from 'lucide-preact';
import { boardApi, type BoardApi, type TimelineEntry, type TimelineView } from './api.ts';

// Project timeline: epics, cards and merged PRs as one newest-first feed.
// Per-view request/response (git-page convention D6) — the feed recomputes
// from current board state on every open/refresh, so it never drifts.

function entryIcon(entry: TimelineEntry): VNode {
  if (entry.kind === 'pr') return <GitPullRequest size={13} />;
  if (entry.kind === 'epic') return <Target size={13} />;
  return entry.lane === 'done' ? <Zap size={13} /> : <Clock size={13} />;
}

function dateLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso.slice(0, 10)
    : date.toISOString().slice(0, 10);
}

function Row({ entry }: { entry: TimelineEntry }): VNode {
  return (
    <li class="timeline-row" data-kind={entry.kind} data-testid={`timeline-${entry.kind}`}>
      <span class="timeline-icon">{entryIcon(entry)}</span>
      <span class="timeline-date">{dateLabel(entry.at)}</span>
      <span class="timeline-title">
        {entry.kind === 'pr' && entry.url !== undefined ? (
          <a href={entry.url} target="_blank" rel="noreferrer" class="timeline-link">
            #{entry.issueNumber} {entry.title}
          </a>
        ) : (
          entry.title
        )}
      </span>
      {entry.verb !== undefined ? <span class="badge b-2">{entry.verb}</span> : null}
      {entry.lane !== undefined ? <span class="badge">{entry.lane}</span> : null}
      {entry.progress !== undefined ? <span class="badge b-primary">{entry.progress}</span> : null}
    </li>
  );
}

export function Timeline({ project, api = boardApi }: { project: string; api?: BoardApi }): VNode {
  const [view, setView] = useState<TimelineView | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    // fixture apis may lack the timeline fetch — degrade, never crash
    if (api.fetchTimeline === undefined) {
      setView(null);
      return;
    }
    api
      .fetchTimeline(project)
      .then(setView)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [api, project]);

  useEffect(load, [load]);

  return (
    <div class="timeline" aria-label="project timeline">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <h2 class="sub" style="margin:0">project timeline</h2>
        <button type="button" class="btn btn-outline" onClick={load} data-testid="timeline-refresh">
          <RefreshCw size={13} /> refresh
        </button>
        {view !== null && view.pulls === 'unavailable' ? (
          <span class="badge b-warning">PRs unavailable — gh offline, cards only</span>
        ) : null}
      </div>
      {error !== '' ? <div class="callout c-warn">{error}</div> : null}
      {view === null && error === '' ? (
        <div role="status" aria-label="loading timeline">loading…</div>
      ) : null}
      {view !== null && view.entries.length === 0 ? (
        <div class="callout c-info">no timeline events yet — capture a note or merge a PR</div>
      ) : null}
      {view !== null && view.entries.length > 0 ? (
        <ol class="timeline-list" style="list-style:none;margin:0;padding:0">
          {view.entries.map((entry, index) => (
            <Row key={`${entry.at}-${entry.cardId ?? entry.url ?? index}`} entry={entry} />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

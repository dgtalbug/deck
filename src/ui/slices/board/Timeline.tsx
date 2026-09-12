import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { Clock, GitCommitHorizontal, GitPullRequest, RefreshCw, Target, Zap } from 'lucide-preact';
import { boardApi, type BoardApi, type TimelineEntry, type TimelineView } from './api.ts';

// Project timeline: epics, cards, merged PRs and commits as one newest-first
// day-grouped feed (design: .meta/design/timeline-mockup.html). Per-view
// request/response (git-page convention D6) — recomputed from current board
// state on every open/refresh, so it never drifts. Kind filtering and day
// collapse are component-local; load-more fetches a deeper ?limit= page.

type KindFilter = 'all' | 'epic' | 'card' | 'pr' | 'commit';

const FILTERS: readonly { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'all' },
  { id: 'epic', label: 'epics' },
  { id: 'card', label: 'cards' },
  { id: 'pr', label: 'pull requests' },
  { id: 'commit', label: 'commits' },
];

const PAGE = 50;

function entryIcon(entry: TimelineEntry): VNode {
  if (entry.kind === 'pr') return <GitPullRequest size={13} />;
  if (entry.kind === 'commit') return <GitCommitHorizontal size={13} />;
  if (entry.kind === 'epic') return <Target size={13} />;
  return entry.lane === 'done' ? <Zap size={13} /> : <Clock size={13} />;
}

const KIND_LABEL: Record<TimelineEntry['kind'], string> = {
  epic: 'epic',
  card: 'card',
  pr: 'pull request',
  commit: 'commit',
};

function whenLabel(iso: string, now: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const diffMs = now - date.getTime();
  if (diffMs < 3_600_000) return `${Math.max(1, Math.floor(diffMs / 60_000))}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  if (diffMs < 7 * 86_400_000) return `${Math.floor(diffMs / 86_400_000)}d ago`;
  return date.toISOString().slice(0, 10);
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const today = new Date();
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(today) - midnight(date)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return date.toISOString().slice(0, 10);
}

export interface DayGroup {
  key: string;
  label: string;
  entries: TimelineEntry[];
}

// Pure: slice a newest-first list into calendar-day groups (browser-local
// day). Days with no entries after filtering are simply absent.
export function groupedByDay(entries: TimelineEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const key = dayLabel(entry.at);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key) last.entries.push(entry);
    else groups.push({ key, label: key, entries: [entry] });
  }
  return groups;
}

function Row({ entry, now }: { entry: TimelineEntry; now: number }): VNode {
  return (
    <li class="timeline-row" data-kind={entry.kind} data-lane={entry.lane} data-testid={`timeline-${entry.kind}`}>
      <span class="timeline-icon">{entryIcon(entry)}</span>
      <span class="timeline-title">
        {entry.url !== undefined ? (
          <a href={entry.url} target="_blank" rel="noreferrer" class="timeline-link">
            {entry.kind === 'commit' && entry.shortSha !== undefined ? `${entry.shortSha} ` : ''}
            {entry.kind === 'pr' && entry.issueNumber !== undefined ? `#${entry.issueNumber} ` : ''}
            {entry.title}
          </a>
        ) : (
          <>
            {entry.kind === 'commit' && entry.shortSha !== undefined ? (
              <span class="timeline-sha">{entry.shortSha} </span>
            ) : null}
            {entry.title}
          </>
        )}
      </span>
      <span class="timeline-kind-label">{KIND_LABEL[entry.kind]}</span>
      {entry.verb !== undefined ? <span class="badge b-2">{entry.verb}</span> : null}
      {entry.lane !== undefined ? <span class="badge">{entry.lane}</span> : null}
      {entry.progress !== undefined ? <span class="badge b-primary">{entry.progress}</span> : null}
      <span class="timeline-when" title={entry.at}>
        {whenLabel(entry.at, now)}
      </span>
    </li>
  );
}

function DaySection({
  group,
  open,
  onToggle,
  now,
}: {
  group: DayGroup;
  open: boolean;
  onToggle: () => void;
  now: number;
}): VNode {
  return (
    <section class="timeline-day" data-day={group.key}>
      <button type="button" class="timeline-day-head" aria-expanded={open} onClick={onToggle}>
        <span class="timeline-day-tw">{open ? '▾' : '▸'}</span>
        <span class="timeline-day-name">{group.label}</span>
        <span class="timeline-day-count">{group.entries.length}</span>
      </button>
      {open ? (
        <ol class="timeline-list">
          {group.entries.map((entry, index) => (
            <Row key={`${entry.at}-${entry.cardId ?? entry.url ?? entry.shortSha ?? index}`} entry={entry} now={now} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function SkeletonRows(): VNode {
  return (
    <div class="timeline-skel" role="status" aria-label="loading timeline">
      {[64, 46, 58, 38].map((width, index) => (
        <div class="timeline-skel-row" key={index}>
          <span class="skel skel-chip" style="width:26px;height:26px;border-radius:999px" />
          <span class="skel skel-line" style={`width:${width}%`} />
          <span class="skel skel-line" style="width:48px" />
        </div>
      ))}
    </div>
  );
}

export function Timeline({ project, api = boardApi }: { project: string; api?: BoardApi }): VNode {
  const [view, setView] = useState<TimelineView | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<KindFilter>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);

  const load = useCallback(
    (atLimit: number) => {
      setError('');
      if (api.fetchTimeline === undefined) {
        setView(null);
        return;
      }
      api
        .fetchTimeline(project, atLimit)
        .then(setView)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [api, project],
  );

  useEffect(() => {
    load(PAGE);
    setLimit(PAGE);
    setCollapsed(new Set());
  }, [load]);

  const now = useMemo(() => Date.now(), [view]);
  const groups = useMemo(
    () => groupedByDay(view?.entries.filter((entry) => filter === 'all' || entry.kind === filter) ?? []),
    [view, filter],
  );
  // default: first (newest) day open, older days collapsed; explicit toggles win
  const dayOpen = (index: number, key: string): boolean => {
    if (collapsed.has(`open:${key}`)) return true;
    if (collapsed.has(`closed:${key}`)) return false;
    return index === 0;
  };
  const toggle = (index: number, key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      const open = dayOpen(index, key);
      next.delete(`open:${key}`);
      next.delete(`closed:${key}`);
      next.add(open ? `closed:${key}` : `open:${key}`);
      return next;
    });
  };

  const loadMore = () => {
    const next = limit + PAGE;
    setLimit(next);
    load(next);
  };

  return (
    <div class="timeline" aria-label="project timeline">
      <div class="tl-bar">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            class="chip-btn"
            aria-pressed={filter === f.id}
            data-testid={`timeline-filter-${f.id}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        <span style="flex:1" />
        <button type="button" class="chip-btn" onClick={() => load(limit)} data-testid="timeline-refresh">
          <RefreshCw size={13} /> refresh
        </button>
      </div>

      {view !== null && view.sources.pulls === 'unavailable' ? (
        <div class="callout c-warn timeline-note">
          PR events unavailable — gh is offline; showing cards and commits.
        </div>
      ) : null}
      {view !== null && view.sources.commits === 'unavailable' ? (
        <div class="callout c-warn timeline-note">
          Commits unavailable — git history could not be read; showing cards and PRs.
        </div>
      ) : null}
      {error !== '' ? <div class="callout c-warn">{error}</div> : null}

      {view === null && error === '' ? (
        <SkeletonRows />
      ) : null}
      {view !== null && view.entries.length === 0 ? (
        <div class="callout c-info">
          No timeline events yet — capture a note or merge your first PR; the feed fills as the project moves.
        </div>
      ) : null}
      {view !== null && groups.length === 0 && view.entries.length > 0 ? (
        <div class="callout c-info">No {filter === 'pr' ? 'pull requests' : `${filter} events`} in this window — try load more or another filter.</div>
      ) : null}

      {groups.map((group, index) => (
        <DaySection
          key={group.key}
          group={group}
          open={dayOpen(index, group.key)}
          onToggle={() => toggle(index, group.key)}
          now={now}
        />
      ))}

      {view !== null && view.entries.length >= limit ? (
        <button type="button" class="chip-btn timeline-load-more" onClick={loadMore} data-testid="timeline-load-more">
          load {PAGE} more
        </button>
      ) : null}
    </div>
  );
}

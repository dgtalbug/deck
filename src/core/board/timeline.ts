import { listMergedPullRequests, listRecentCommits } from '../git/ops.ts';
import { runGit } from '../git/digest.ts';
import { getIssueMap } from './specstore.ts';
import type { DocumentStore } from './store.ts';
import { isEpic, isVerbItem, type Card, type Lane } from './types.ts';

// The project timeline: one delivery narrative blending planning cards
// (epics, stories, tasks) with the GitHub record (merged PR titles, commit
// subjects). Every row is recomputed from current board state — no counters
// to drift; PRs come from `gh`, commits from local git, both at read time.
// Newest first. Source outages degrade per-source — never a failed read.

export type TimelineKind = 'epic' | 'card' | 'pr' | 'commit';

export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  title: string;
  cardId?: string | undefined;
  epicId?: string | undefined;
  lane?: Lane | undefined;
  verb?: string | undefined;
  progress?: string | undefined;
  issueNumber?: number | null | undefined;
  url?: string | undefined;
  shortSha?: string | undefined;
}

export type SourceHealth = 'ok' | 'unavailable';

export interface TimelineView {
  view: 'timeline';
  entries: TimelineEntry[];
  // per-source health; `pulls` is the deprecated v1 alias kept for clients
  sources: { pulls: SourceHealth; commits: SourceHealth };
  pulls: SourceHealth;
}

function cardEntries(store: DocumentStore, card: Card): TimelineEntry[] {
  if (isEpic(card)) {
    return [{ at: card.createdAt, kind: 'epic', title: card.title, cardId: card.id }];
  }
  // Structural check, not isNote: verb items are assignable to Note, so the
  // predicate's false branch would wrongly narrow them away.
  if (!('lane' in card)) return [];
  // verb items and tweaks: created, plus a done event when archived —
  // the two moments a timeline reader cares about. Snapshot the shared
  // fields up front — later type-guard narrowing must not re-check them.
  const { createdAt, title, id, epicId, lane, updatedAt } = card;
  const base: TimelineEntry = {
    at: createdAt,
    kind: 'card',
    title,
    cardId: id,
    epicId,
    lane,
    issueNumber: getIssueMap(store, id)?.issueNumber ?? null,
  };
  if (isVerbItem(card)) {
    const done = card.tasks.filter((task) => task.done).length;
    base.verb = card.verb;
    base.progress = `${done}/${card.tasks.length}`;
  }
  const entries = [base];
  if (lane === 'done') {
    entries.push({ ...base, at: updatedAt, title: `done — ${title}` });
  }
  return entries;
}

export function cardTimeline(store: DocumentStore): TimelineEntry[] {
  return store
    .listCards()
    .flatMap((card) => cardEntries(store, card))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// git@github.com:o/r.git | https://github.com/o/r.git → https://github.com/o/r
async function githubBase(projectPath: string): Promise<string | null> {
  const result = await runGit(projectPath, ['remote', 'get-url', 'origin'], 5000);
  const raw = result.stdout.trim();
  if (result.code !== 0 || raw === '') return null;
  const ssh = raw.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  const https = raw.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  const slug = ssh?.[1] ?? https?.[1];
  return slug === undefined ? null : `https://github.com/${slug}`;
}

export async function timelineView(store: DocumentStore, limit = 50): Promise<TimelineView> {
  const entries = cardTimeline(store);
  const sources: TimelineView['sources'] = { pulls: 'ok', commits: 'ok' };

  // merged PRs (gh) — mergeCommit oids drive the commit dedup below
  let mergeOids = new Set<string>();
  try {
    const merged = await listMergedPullRequests(store.projectPath, limit);
    mergeOids = new Set(
      merged.map((pr) => pr.mergeCommit?.oid).filter((oid): oid is string => oid !== undefined),
    );
    entries.push(
      ...merged.map((pr) => ({
        at: pr.mergedAt,
        kind: 'pr' as const,
        title: pr.title,
        url: pr.url,
        issueNumber: pr.number,
      })),
    );
  } catch {
    sources.pulls = 'unavailable';
  }

  // commits (local git log) — a commit that IS a PR's merge commit renders
  // once, as the PR row (it carries the link)
  try {
    const base = await githubBase(store.projectPath);
    const commits = await listRecentCommits(store.projectPath, limit);
    for (const commit of commits) {
      if (mergeOids.has(commit.sha)) continue;
      entries.push({
        at: commit.date,
        kind: 'commit',
        title: commit.subject,
        shortSha: commit.shortSha,
        url: base === null ? undefined : `${base}/commit/${commit.sha}`,
      });
    }
  } catch {
    sources.commits = 'unavailable';
  }

  entries.sort((a, b) => b.at.localeCompare(a.at));
  return { view: 'timeline', entries: entries.slice(0, limit), sources, pulls: sources.pulls };
}

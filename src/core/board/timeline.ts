import { listMergedPullRequests } from '../git/ops.ts';
import { getIssueMap } from './specstore.ts';
import type { DocumentStore } from './store.ts';
import { isEpic, isVerbItem, type Card, type Lane } from './types.ts';

// The project timeline: one delivery narrative blending planning cards
// (epics, stories, tasks) with the GitHub record (merged PR titles). Every
// row is recomputed from current board state — no counters to drift; PR
// events come straight from `gh` at read time. Newest first.

export type TimelineKind = 'epic' | 'card' | 'pr';

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
}

export interface TimelineView {
  view: 'timeline';
  entries: TimelineEntry[];
  pulls: 'ok' | 'unavailable';
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

export async function timelineView(store: DocumentStore, limit = 50): Promise<TimelineView> {
  const entries = cardTimeline(store);
  // gh offline degrades to a cards-only timeline — never a failed read.
  let pulls: TimelineView['pulls'] = 'ok';
  try {
    const merged = await listMergedPullRequests(store.projectPath, limit);
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
    pulls = 'unavailable';
  }
  entries.sort((a, b) => b.at.localeCompare(a.at));
  return { view: 'timeline', entries: entries.slice(0, limit), pulls };
}

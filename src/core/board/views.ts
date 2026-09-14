import type { DocumentStore } from './store.ts';
import { unmetDependencies } from './planning.ts';
import { isVerbItem, type Card, type Lane } from './types.ts';

export type CardView = Record<string, unknown>;

export interface PlanningStatus {
  blockers: Array<{ id: string; lane: string; title: string }>;
  reviewNeeded: boolean;
}

export function planningStatus(store: DocumentStore, card: Card): PlanningStatus | undefined {
  if (!isVerbItem(card)) return undefined;
  const blockers = unmetDependencies(store, card.id);
  const reviewNeeded =
    blockers.length > 0 && (card.lane === 'active' || card.lane === 'verify' || card.lane === 'done');
  if (blockers.length === 0 && !reviewNeeded) return undefined;
  return { blockers, reviewNeeded };
}

export function cardView(card: Card, planning?: PlanningStatus | undefined): CardView {
  if (!('lane' in card)) return { ...card };
  const view: CardView = { ...card };
  if (isVerbItem(card)) {
    const done = card.tasks.filter((task) => task.done).length;
    view['progress'] = `${done}/${card.tasks.length}`;
  }
  if (planning !== undefined) {
    view['unmetDeps'] = planning.blockers;
    view['reviewNeeded'] = planning.reviewNeeded;
  }
  return view;
}

const LANES: Lane[] = ['todo', 'groomed', 'active', 'verify', 'done'];

export interface BoardView {
  lanes: Record<Lane, CardView[]>;
  epics: EpicRollup[];
}

export interface EpicRollup {
  id: string;
  title: string;
  stories: number;
  done: number;
}

export function epicRollups(store: DocumentStore): EpicRollup[] {
  return store.listEpics().map((epic) => {
    const stories = store.epicStories(epic.id);
    const done = stories.filter((story) => 'lane' in story && story.lane === 'done').length;
    return { id: epic.id, title: epic.title, stories: stories.length, done };
  });
}

// Ordinary board reads show live work only; epic rollups deliberately stay
// inclusive of historical children so live parents keep accurate totals.
function isLive(card: Card): boolean {
  return !('historyAt' in card && card.historyAt !== undefined);
}

export function boardView(store: DocumentStore): BoardView {
  const lanes = {} as Record<Lane, CardView[]>;
  for (const lane of LANES) {
    lanes[lane] = store
      .listCards(lane)
      .filter(isLive)
      .map((card) => cardView(card, planningStatus(store, card)));
  }
  return { lanes, epics: epicRollups(store) };
}

export interface TodoView {
  view: 'todo';
  cards: CardView[];
  epics: EpicRollup[];
}

export function todoView(store: DocumentStore): TodoView {
  return {
    view: 'todo',
    cards: [...store.listCards('todo'), ...store.listCards('groomed')].filter(isLive).map((card) =>
      cardView(card, planningStatus(store, card)),
    ),
    epics: epicRollups(store),
  };
}

import type { DocumentStore } from './store.ts';
import { isVerbItem, type Card, type Lane } from './types.ts';

// Read-model views over the store. Routes (and later the CLI/UI) render
// these; the shape is the API contract returned by GET /:project/board.
export type CardView = Record<string, unknown>;

// Verb items carry a progress badge ("done/total"); notes and tweaks render bare.
export function cardView(card: Card): CardView {
  if (!('lane' in card)) return { ...card };
  const view: CardView = { ...card };
  if (isVerbItem(card)) {
    const done = card.tasks.filter((task) => task.done).length;
    view['progress'] = `${done}/${card.tasks.length}`;
  }
  return view;
}

const LANES: Lane[] = ['todo', 'groomed', 'active', 'verify', 'done'];

export interface BoardView {
  lanes: Record<Lane, CardView[]>;
  epics: EpicRollup[];
}

// Per-epic rollup: stories done/total, computed live from card state —
// no counters to drift.
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

export function boardView(store: DocumentStore): BoardView {
  // Notes carry no lane field in the domain model, so bucket by query,
  // not by filtering a flat list.
  const lanes = {} as Record<Lane, CardView[]>;
  for (const lane of LANES) {
    lanes[lane] = store.listCards(lane).map(cardView);
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
    cards: [...store.listCards('todo'), ...store.listCards('groomed')].map(cardView),
    epics: epicRollups(store),
  };
}

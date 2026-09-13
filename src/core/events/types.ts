// Event names and payloads per .meta/board-epic.md "Events" table, plus the
// v0.2.0 additive CRUD events (card.updated / card.deleted).
export type BoardEventType =
  | 'card.created'
  | 'card.groomed'
  | 'card.moved'
  | 'card.tasks.updated'
  | 'card.blocked'
  | 'card.unblocked'
  | 'card.done'
  | 'card.updated'
  | 'card.deleted'
  // E03 planning events (scope identity, epic intent, dependency edges)
  | 'card.deps.updated'
  | 'epic.intent.updated'
  | 'epic.criterion.linked'
  | 'epic.criterion.deferred'
  | 'epic.parent.acknowledged';

export interface CardLanePayload {
  id: string;
  lane: string;
  position: number;
}

export interface CardTasksPayload {
  id: string;
  tasks: { title: string; done: boolean }[];
  progress: string; // "done/total"
}

export interface CardBlockedPayload {
  id: string;
  reason?: string;
}

export interface CardDonePayload {
  id: string;
  wikiPath: string;
}

// E03 planning events carry free-form detail payloads (id + context fields).
export interface PlanningEventPayload {
  id: string;
  [key: string]: unknown;
}

export type BoardEventPayload =
  | CardLanePayload
  | CardTasksPayload
  | CardBlockedPayload
  | CardDonePayload
  | PlanningEventPayload;

export interface BoardEvent {
  rowid: number;
  type: BoardEventType;
  payload: BoardEventPayload;
  createdAt: string;
}

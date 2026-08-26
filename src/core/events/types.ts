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
  | 'card.deleted';

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

export type BoardEventPayload =
  | CardLanePayload
  | CardTasksPayload
  | CardBlockedPayload
  | CardDonePayload;

export interface BoardEvent {
  rowid: number;
  type: BoardEventType;
  payload: BoardEventPayload;
  createdAt: string;
}

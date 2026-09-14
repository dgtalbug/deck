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
  | 'card.deps.updated'
  | 'epic.intent.updated'
  | 'epic.criterion.linked'
  | 'epic.criterion.deferred'
  | 'epic.parent.acknowledged'
  | 'task.assigned'
  | 'task.patched'
  | 'handoff.offered'
  | 'handoff.accepted'
  | 'handoff.cancelled';

export interface CardLanePayload {
  id: string;
  lane: string;
  position: number;
}

export interface CardTasksPayload {
  id: string;
  tasks: { title: string; done: boolean }[];
  progress: string; 
}

export interface CardBlockedPayload {
  id: string;
  reason?: string;
}

export interface CardDonePayload {
  id: string;
  wikiPath: string;
}

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

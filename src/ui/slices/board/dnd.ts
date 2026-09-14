import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import type { UiCard } from './api.ts';

export type DropIntent =
  | { kind: 'move'; id: string; to: 'todo' | 'groomed' }
  | { kind: 'reorder'; id: string; afterId: string | undefined };

export interface DragCallbacks {
  onIntent(intent: DropIntent): void;
  onDragState(active: boolean, lane: string): void;
}

interface CardDragData {
  id: string;
  lane: string;
}

function dataOf(source: { data: Record<string, unknown> }): CardDragData {
  return source.data as unknown as CardDragData;
}

export function isManualLane(lane: string): boolean {
  return lane === 'todo' || lane === 'groomed';
}

const disposers = new Set<() => void>();
function tracked(cleanup: () => void): () => void {
  disposers.add(cleanup);
  return cleanup;
}

let registeredCards: WeakSet<HTMLElement> = new WeakSet();
let registeredBodies: WeakSet<HTMLElement> = new WeakSet();

export function cardRegistered(element: HTMLElement): boolean {
  return registeredCards.has(element);
}

export function markCardRegistered(element: HTMLElement): void {
  registeredCards.add(element);
}

export function bodyRegistered(element: HTMLElement): boolean {
  return registeredBodies.has(element);
}

export function markBodyRegistered(element: HTMLElement): void {
  registeredBodies.add(element);
}

export function disposeDnd(): void {
  for (const dispose of disposers) dispose();
  disposers.clear();
  registeredCards = new WeakSet();
  registeredBodies = new WeakSet();
}

export function registerCardDrag(element: HTMLElement, card: UiCard, lane: 'todo' | 'groomed', callbacks: DragCallbacks): () => void {
  if (!isManualLane(lane)) return () => {};
  return tracked(draggable({
    element,
    getInitialData: () => ({ id: card.id, lane }),
    onDragStart: () => callbacks.onDragState(true, lane),
    onDrop: () => callbacks.onDragState(false, lane),
  }));
}

export function registerCardDrop(element: HTMLElement, lane: 'todo' | 'groomed', callbacks: DragCallbacks): () => void {
  if (!isManualLane(lane)) return () => {};
  return tracked(dropTargetForElements({
    element,
    canDrop: ({ source }) => dataOf(source).lane === lane,
    onDragEnter: ({ self, source }) => {
      if (dataOf(source).lane === lane) self.element.classList.add('is-drop-target');
    },
    onDragLeave: ({ self }) => self.element.classList.remove('is-drop-target'),
    onDrop: ({ source, self }) => {
      self.element.classList.remove('is-drop-target');
      const data = dataOf(source);
      callbacks.onIntent({ kind: 'reorder', id: data.id, afterId: self.element.getAttribute('data-id') ?? undefined });
    },
  }));
}

export function registerLaneDrop(element: HTMLElement, lane: 'todo' | 'groomed', callbacks: DragCallbacks): () => void {
  if (!isManualLane(lane)) return () => {};
  return tracked(dropTargetForElements({
    element,
    canDrop: ({ source }) => dataOf(source).lane !== lane,
    onDragEnter: ({ self, source }) => {
      if (dataOf(source).lane !== lane) self.element.classList.add('is-drop-target');
    },
    onDragLeave: ({ self }) => self.element.classList.remove('is-drop-target'),
    onDrop: ({ source, self }) => {
      self.element.classList.remove('is-drop-target');
      const data = dataOf(source);
      if (data.lane !== lane) {
        callbacks.onIntent({ kind: 'move', id: data.id, to: lane });
      }
    },
  }));
}

export function registerDragMonitor(root: () => HTMLElement | null): () => void {
  return tracked(monitorForElements({
    onDragStart: ({ source, location }) => {
      (source.element as HTMLElement).classList.add('is-dragging');
      paintForbidden(root(), location.current.input.clientX, location.current.input.clientY);
    },
    onDrag: ({ location }) => {
      paintForbidden(root(), location.current.input.clientX, location.current.input.clientY);
    },
    onDrop: ({ source }) => {
      (source.element as HTMLElement).classList.remove('is-dragging');
      for (const lane of root()?.querySelectorAll('.lane') ?? []) lane.classList.remove('is-drop-forbidden');
    },
  }));
}

function paintForbidden(root: HTMLElement | null, x: number, y: number): void {
  if (root === null) return;
  const hovered = document.elementFromPoint(x, y);
  for (const lane of root.querySelectorAll('.lane')) {
    const isHovered = hovered !== null && lane.contains(hovered);
    const engine = lane.classList.contains('is-engine');
    lane.classList.toggle('is-drop-forbidden', isHovered && engine);
  }
}

export function keyboardAfterId(laneCards: UiCard[], id: string, direction: 'up' | 'down'): string | undefined {
  const index = laneCards.findIndex((card) => card.id === id);
  if (index === -1) return undefined;
  if (direction === 'up') {
    if (index <= 1) return undefined; 
    return laneCards[index - 2]!.id;
  }
  return laneCards[index + 1]?.id;
}

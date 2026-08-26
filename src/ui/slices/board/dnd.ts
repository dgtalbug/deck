import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import type { UiCard } from './api.ts';

// Restricted drag (D-UI-07 + design D3): draggables on todo/groomed cards;
// droppables ONLY on todo/groomed lane bodies and same-lane card reorder
// slots. Engine lanes never register a droppable — refusal is structural:
// no request targeting active/verify/done can even be constructed here.

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

// pdd mounts its document-level adapter listeners ONCE per process (usage
// ledger): the document global at the first registration wins. In tests,
// every Board-mounting file swaps in a fresh happy-dom window — so each
// file must return the usage count to zero or the NEXT file's drag events
// are unheard. Every registration's disposer is tracked here; test files
// call disposeDnd() in afterAll. In the app there is one document for the
// process lifetime, so this never runs there.
const disposers = new Set<() => void>();
function tracked(cleanup: () => void): () => void {
  disposers.add(cleanup);
  return cleanup;
}

export function disposeDnd(): void {
  for (const dispose of disposers) dispose();
  disposers.clear();
  // WeakSet has no clear — swap fresh sets so later remounts re-register
  registeredCards = new WeakSet();
  registeredBodies = new WeakSet();
}

// once-per-element registration marks (keyed diffs reuse DOM nodes; see
// Card.tsx / Lane.tsx) — swapped by disposeDnd so remounts re-register.
export let registeredCards: WeakSet<HTMLElement> = new WeakSet();
export let registeredBodies: WeakSet<HTMLElement> = new WeakSet();

// Draggable per card (todo/groomed only — engine cards never register).
export function registerCardDrag(element: HTMLElement, card: UiCard, lane: 'todo' | 'groomed', callbacks: DragCallbacks): () => void {
  if (!isManualLane(lane)) return () => {};
  return tracked(draggable({
    element,
    getInitialData: () => ({ id: card.id, lane }),
    onDragStart: () => callbacks.onDragState(true, lane),
    onDrop: () => callbacks.onDragState(false, lane),
  }));
}

// Same-lane reorder slot: dropping ON a card reorders after it.
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

// Lane body droppable: the cross-lane todo ↔ groomed move target.
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

// `.is-dragging` on the source card; `.is-drop-forbidden` paints engine
// lanes while a drag hovers them (they have no droppable — visual only).
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

// Keyboard parity (task 7.3): Alt+↑/↓ reorder targets — pure so the
// walkthrough test needs no pointer at all.
export function keyboardAfterId(laneCards: UiCard[], id: string, direction: 'up' | 'down'): string | undefined {
  const index = laneCards.findIndex((card) => card.id === id);
  if (index === -1) return undefined;
  if (direction === 'up') {
    if (index <= 1) return undefined; // moving to the very top → no afterId
    return laneCards[index - 2]!.id;
  }
  return laneCards[index + 1]?.id;
}

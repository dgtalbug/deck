import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { ArrowRightLeft, RadioTower } from 'lucide-preact';
import { signal } from '@preact/signals';
import { boardApi, type BoardApi, type GroomInput, type UiCard } from './api.ts';
import { registerDragMonitor, type DragCallbacks } from './dnd.ts';
import { createBoardStore } from './store.ts';
import { subscribeBoardEvents, type SseSubscription } from './sse.ts';
import { route, setParam } from '../../router.ts';
import { Lane, LANE_ORDER } from './Lane.tsx';
import { FilterBar } from './FilterBar.tsx';
import { TodoView } from './TodoView.tsx';
import { CardDetail, type DetailActions } from './CardDetail.tsx';
import { GroomForm } from './GroomForm.tsx';
import { NoteCapture } from './NoteCapture.tsx';
import { Banners } from './Banners.tsx';
import { NextPanel } from './NextPanel.tsx';
import { ToastHost } from '../../components/Toast.tsx';

// Board view: one signals store per project, SSE deltas applied in batches,
// kanban + todo over the same document. Every mutation is optimistic →
// response replace → rollback; engine lanes change only via server data.

export interface BoardProps {
  project: string;
  api?: BoardApi;
  subscribe?: typeof subscribeBoardEvents;
}

export function Board({ project, api = boardApi, subscribe = subscribeBoardEvents }: BoardProps): VNode {
  const store = useMemo(() => createBoardStore(project, api), [project, api]);
  const containerRef = useRef<HTMLElement | null>(null);
  const [groomingId, setGroomingId] = useState<string | null>(null);
  const [nextOpen, setNextOpen] = useState(false);
  // Lane pinning (design D3): while a drag is active, SSE deltas re-render
  // other lanes; the dragged lane shows its drag-start snapshot until drop.
  const pinnedLane = signal<{ lane: string; cards: UiCard[] } | null>(null);
  const dragCallbacks: DragCallbacks = {
    onIntent: (intent) => {
      pinnedLane.value = null;
      if (intent.kind === 'move') void store.move(intent.id, intent.to);
      else void store.reorder(intent.id, intent.afterId);
    },
    onDragState: (active, lane) => {
      pinnedLane.value = active ? { lane, cards: store.laneCards(lane as 'todo') } : null;
    },
  };
  useEffect(() => registerDragMonitor(() => containerRef.current), []);

  useEffect(() => {
    void store.refetch();
    let subscription: SseSubscription | undefined;
    subscription = subscribe(project, {
      onEvents: (events) => store.applyEvents(events),
      onOpen: () => {
        store.setOnline(true);
        void store.refetch(); // close the no-resume gap on every (re)connect
      },
      onError: () => store.setOnline(false),
    });
    return () => subscription?.stop();
  }, [store, project, subscribe]);

  const actions = {
    onOpen: (id: string) => setParam('card', id),
    onGroom: (id: string) => setGroomingId(id),
    onTweak: (id: string) => void store.tweak(id),
    onMove: (id: string, to: 'todo' | 'groomed') => void store.move(id, to),
    onKeyboardReorder: (id: string, afterId: string | undefined) => void store.reorder(id, afterId),
  };

  const detailActions: DetailActions = {
    onClose: () => setParam('card', null),
    onMoveToTodo: (id) => void store.move(id, 'todo'),
    onBlock: (id, reason) => void store.block(id, reason),
    onUnblock: (id) => void store.unblock(id),
    onTweak: (id) => void store.tweak(id),
    onDemote: (id) => void store.demote(id),
    onNext: () => setNextOpen(true),
  };

  const view = route.value.view;
  const detailCard = route.value.card !== null ? store.cardById(route.value.card) : undefined;
  const groomNote = groomingId !== null ? store.cardById(groomingId) : undefined;

  const onGroomAccept = (input: GroomInput) => {
    if (groomingId === null) return;
    void store.groom(groomingId, input);
    setGroomingId(null);
  };

  const pinned = pinnedLane.value;
  const laneCardsOf = (lane: (typeof LANE_ORDER)[number]) =>
    pinned !== null && pinned.lane === lane ? pinned.cards : store.filtered(lane);

  return (
    <section ref={containerRef}>
      <h1 class="page">
        {project} <span class="grad-text">{view === 'todo' ? 'todo' : 'board'}</span>
      </h1>
      <p class="subtitle">
        Capture → groom → prioritize. The engine owns everything after <code>groomed</code>.
      </p>

      <Banners online={store.online.value} />
      {!store.online.value ? (
        <div class="callout c-warn banner">
          <RadioTower size={15} />
          <div>
            <strong class="label">deck server unreachable</strong>
            Showing the last known board (stale). Reconnecting with backoff — the board refetches on reopen.
          </div>
        </div>
      ) : null}

      <FilterBar
        filter={store.filter.value}
        onFilter={(partial) => store.setFilter(partial)}
        view={view}
        onView={(next) => setParam('view', next === 'kanban' ? null : 'todo')}
        onNote={() => window.dispatchEvent(new CustomEvent('deck:focus-note'))}
      />

      <NoteCapture onAdd={(title) => store.addNote(title)} />

      {view === 'kanban' ? (
        <div class="board">
          {LANE_ORDER.map((lane) => (
            <Lane
              key={lane}
              lane={lane}
              cards={laneCardsOf(lane)}
              actions={actions}
              wip={store.wip.value}
              dnd={{ callbacks: dragCallbacks }}
              emptyHint={lane === 'todo' ? 'inbox zero — capture a note below' : 'engine moves cards here via deck next'}
            />
          ))}
        </div>
      ) : (
        <TodoView store={{ filtered: store.filtered }} actions={actions} />
      )}

      <div class="callout c-info" style="margin-top:14px">
        <ArrowRightLeft size={15} />
        <div>
          <strong class="label">restricted drag</strong>
          Drag reorders any lane and moves cards <code>todo ↔ groomed</code> only. <code>active / verify / done</code> are
          engine-owned — drops land nowhere, and the store rejects them server-side too.
        </div>
      </div>

      <NextPanel
        store={store}
        open={nextOpen}
        onClose={() => setNextOpen(false)}
      />

      {detailCard !== undefined ? (
        <CardDetail
          card={detailCard}
          actions={detailActions}
          specMarkdown={detailCard.specPath !== undefined ? `spec: ${detailCard.specPath}` : '# no spec yet'}
        />
      ) : null}

      {groomNote !== undefined ? (
        <GroomForm
          noteTitle={groomNote.title}
          onAccept={onGroomAccept}
          onReject={() => setGroomingId(null)}
        />
      ) : null}
      <ToastHost />
    </section>
  );
}

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { ArrowRightLeft, RadioTower } from 'lucide-preact';
import { signal } from '@preact/signals';
import { boardApi, type BoardApi, type GroomInput, type UiCard } from './api.ts';
import { registerDragMonitor, type DragCallbacks } from './dnd.ts';
import { captureFlip, playFlip } from './flip.ts';
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
import { ProjectSidebar } from './ProjectSidebar.tsx';
import { RenameDialog } from './RenameDialog.tsx';
import { DeleteConfirm } from './DeleteConfirm.tsx';
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
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [regroomId, setRegroomId] = useState<string | null>(null);
  const [nextOpen, setNextOpen] = useState(false);
  // Lane pinning (design D3): while a drag is active, SSE deltas re-render
  // other lanes; the dragged lane shows its drag-start snapshot until drop.
  const pinnedLane = signal<{ lane: string; cards: UiCard[] } | null>(null);
  const dragCallbacks: DragCallbacks = {
    onIntent: (intent) => {
      pinnedLane.value = null;
      // FLIP (D-UI-005): snapshot pre-drop rects, animate the user-initiated
      // reorder back from the inverted position once the response lands.
      const flip = captureFlip(containerRef.current);
      const applied =
        intent.kind === 'move'
          ? store.move(intent.id, intent.to)
          : store.reorder(intent.id, intent.afterId);
      void applied.then((ok) => {
        if (ok) playFlip(containerRef.current, flip);
      });
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
    onEditTitle: (id: string) => setRenamingId(id),
    onEditGroom: (id: string) => setRegroomId(id),
    onDelete: (id: string) => setDeletingId(id),
    onBlock: (id: string) => void store.block(id, ''),
    onUnblock: (id: string) => void store.unblock(id),
  };

  const detailActions: DetailActions = {
    onClose: () => setParam('card', null),
    onMoveToTodo: (id) => void store.move(id, 'todo'),
    onBlock: (id, reason) => void store.block(id, reason),
    onUnblock: (id) => void store.unblock(id),
    onTweak: (id) => void store.tweak(id),
    onDemote: (id) => void store.demote(id),
    onNext: () => setNextOpen(true),
    onEditTitle: (id) => {
      setParam('card', null); // editors replace the detail dialog, not stack
      setRenamingId(id);
    },
    onEditGroom: (id) => {
      setParam('card', null);
      setRegroomId(id);
    },
    onDelete: (id) => {
      setParam('card', null);
      setDeletingId(id);
    },
  };

  const view = route.value.view;
  const detailCard = route.value.card !== null ? store.cardById(route.value.card) : undefined;
  const groomNote = groomingId !== null ? store.cardById(groomingId) : undefined;
  const renameCard = renamingId !== null ? store.cardById(renamingId) : undefined;
  const deleteCard = deletingId !== null ? store.cardById(deletingId) : undefined;
  const regroomCard = regroomId !== null ? store.cardById(regroomId) : undefined;

  // kanban↔todo toggle rides the View Transition API when available
  // (D-UI-005); the plain swap is the fallback.
  const switchView = (next: 'kanban' | 'todo') => {
    const go = () => setParam('view', next === 'kanban' ? null : 'todo');
    if (typeof document !== 'undefined' && typeof document.startViewTransition === 'function') {
      document.startViewTransition(go);
    } else {
      go();
    }
  };

  const onGroomAccept = (input: GroomInput) => {
    if (groomingId === null) return;
    void store.groom(groomingId, input);
    setGroomingId(null);
  };

  const pinned = pinnedLane.value;
  const laneCardsOf = (lane: (typeof LANE_ORDER)[number]) =>
    pinned !== null && pinned.lane === lane ? pinned.cards : store.filtered(lane);
  const flashIds = store.remoteMoved.value;

  // ONE note-capture affordance: the ghost card at the top of the todo lane
  // (kanban) / inbox group (todo view) — same card visual language as the
  // notes it creates. `N` focuses it from anywhere outside a field.
  const capture = <NoteCapture onAdd={(title) => store.addNote(title)} />;

  return (
    <div class="board-shell">
      <ProjectSidebar project={project} view={view} onNavigate={switchView} onNext={() => setNextOpen(true)} api={api} />
      <section ref={containerRef}>
      <h1 class="page">
        {project} · {view === 'todo' ? 'todo' : 'board'}
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
      />

      {view === 'kanban' ? (
        <div class="board">
          {LANE_ORDER.map((lane) => (
            <Lane
              key={lane}
              lane={lane}
              cards={laneCardsOf(lane)}
              actions={actions}
              wip={store.wip.value}
              onWipOpen={() => setNextOpen(true)}
              dnd={{ callbacks: dragCallbacks }}
              lead={lane === 'todo' ? capture : undefined}
              flashIds={flashIds}
              emptyHint={lane === 'todo' ? 'inbox zero — capture a note above' : 'engine moves cards here via deck next'}
            />
          ))}
        </div>
      ) : (
        <TodoView store={{ filtered: store.filtered }} actions={actions} lead={capture} />
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

      {renameCard !== undefined ? (
        <RenameDialog
          card={renameCard}
          onAccept={(title) => {
            void store.updateCard(renameCard.id, title);
            setRenamingId(null);
          }}
          onClose={() => setRenamingId(null)}
        />
      ) : null}

      {deleteCard !== undefined ? (
        <DeleteConfirm
          card={deleteCard}
          onConfirm={() => {
            void store.deleteCard(deleteCard.id);
            setDeletingId(null);
          }}
          onClose={() => setDeletingId(null)}
        />
      ) : null}

      {regroomCard !== undefined ? (
        <GroomForm
          mode="edit"
          noteTitle={regroomCard.title}
          initial={{
            proposedVerb: regroomCard.verb ?? 'chore',
            refinedTitle: regroomCard.title,
            research: {
              codebaseFindings: regroomCard.research?.codebaseFindings ?? [],
              ...(regroomCard.research?.rca !== undefined ? { rca: regroomCard.research.rca } : {}),
              ...(regroomCard.research?.blastRadius !== undefined
                ? { blastRadius: regroomCard.research.blastRadius }
                : {}),
            },
            specDeltas: [],
            tasks: (regroomCard.tasks ?? []).map((task) => task.title),
            openQuestions: [],
          }}
          onAccept={(input) => {
            void store.updateGroom(regroomCard.id, input);
            setRegroomId(null);
          }}
          onReject={() => setRegroomId(null)}
        />
      ) : null}
      <ToastHost />
      </section>
    </div>
  );
}

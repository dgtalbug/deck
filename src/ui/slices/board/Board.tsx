import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { ArrowRightLeft, RadioTower } from 'lucide-preact';
import { signal } from '@preact/signals';
import { boardApi, type BoardApi, type EpicTree, type GroomInput, type UiCard } from './api.ts';
import { registerDragMonitor, type DragCallbacks } from './dnd.ts';
import { captureFlip, playFlip } from './flip.ts';
import { createBoardStore } from './store.ts';
import { subscribeBoardEvents, type SseSubscription } from './sse.ts';
import { route, setParam } from '../../router.ts';
import { Lane, LANE_ORDER, LaneSkeleton } from './Lane.tsx';
import { FilterBar } from './FilterBar.tsx';
import { TodoView } from './TodoView.tsx';
import { GitPage } from './GitPage.tsx';
import { CardDetail, CardDetailSkeleton, EpicDetail, type DetailActions } from './CardDetail.tsx';
import { GroomForm } from './GroomForm.tsx';
import { NoteCapture } from './NoteCapture.tsx';
import { Banners } from './Banners.tsx';
import { NextPanel } from './NextPanel.tsx';
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
  // Epic navigation: a detail route that names an epic opens the epic tree
  // instead of a card detail (epics are not lane cards).
  const detailEpicId =
    detailCard === undefined && route.value.card !== null &&
    (store.board.value.epics ?? []).some((epic) => epic.id === route.value.card)
      ? route.value.card
      : null;
  const [epicTree, setEpicTree] = useState<EpicTree | null>(null);
  useEffect(() => {
    if (detailEpicId === null || api.fetchEpicTree === undefined) {
      setEpicTree(null);
      return;
    }
    let alive = true;
    api.fetchEpicTree(project, detailEpicId)
      .then((tree) => alive && setEpicTree(tree))
      .catch(() => alive && setEpicTree(null));
    return () => {
      alive = false;
    };
  }, [detailEpicId, project]);
  const groomNote = groomingId !== null ? store.cardById(groomingId) : undefined;
  const renameCard = renamingId !== null ? store.cardById(renamingId) : undefined;
  const deleteCard = deletingId !== null ? store.cardById(deletingId) : undefined;
  const regroomCard = regroomId !== null ? store.cardById(regroomId) : undefined;

  // kanban↔todo↔git toggle rides the View Transition API when available
  // (D-UI-005); the plain swap is the fallback.
  const switchView = (next: 'kanban' | 'todo' | 'git') => {
    const go = () => setParam('view', next === 'kanban' ? null : next);
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
  // notes it creates. `N` focuses it from anywhere outside a field. Hidden on
  // the git view along with the filter bar (spec: git view is git-only).
  const capture = <NoteCapture onAdd={(title) => store.addNote(title)} />;

  // The project bar (top-bar merge, v0.7.0): the old sidebar's navigation
  // lives in the header row now — segmented view switcher + deck next — so
  // the board keeps the full viewport width for its five lanes. Workspace
  // identity (home link, crumb, theme) stays in the global topbar.
  const viewSwitch = (mode: 'kanban' | 'todo' | 'git', label: string): VNode => (
    <button
      type="button"
      class="view-switch-btn"
      aria-current={view === mode ? 'page' : undefined}
      data-view={mode}
      onClick={() => switchView(mode)}
    >
      {label}
    </button>
  );

  return (
    <div>
      <section ref={containerRef}>
      <div class="board-head-row">
        <h1 class="page" style="margin:0">{project}</h1>
        <nav class="view-switch" aria-label="board views">
          {viewSwitch('kanban', 'board')}
          {viewSwitch('todo', 'todo')}
          {viewSwitch('git', 'git')}
        </nav>
        <button type="button" class="btn btn-outline" onClick={() => setNextOpen(true)} data-testid="deck-next">
          deck next
        </button>
      </div>
      <p class="subtitle">
        {view === 'git' ? (
          'Branch, checkpoint, integrate, publish — guarded git for the SDD loop.'
        ) : (
          <>Capture → groom → prioritize. The engine owns everything after <code>groomed</code>.</>
        )}
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

      {view !== 'git' ? (
        <FilterBar
          filter={store.filter.value}
          onFilter={(partial) => store.setFilter(partial)}
        />
      ) : null}

      {view === 'git' ? (
        <GitPage project={project} api={api} />
      ) : view === 'kanban' && !store.loaded.value ? (
        // board skeleton (brand §4): real chrome — sidebar, lane heads,
        // semantic top-borders — only the card data shimmers
        <div class="board" role="status" aria-label="loading board">
          {LANE_ORDER.map((lane, index) => (
            <LaneSkeleton key={lane} lane={lane} bones={[3, 2, 1, 2, 1][index] ?? 2} />
          ))}
        </div>
      ) : view === 'kanban' ? (
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

      {view !== 'git' ? (
        <div class="callout c-info" style="margin-top:14px">
          <ArrowRightLeft size={15} />
          <div>
            <strong class="label">restricted drag</strong>
            Drag reorders any lane and moves cards <code>todo ↔ groomed</code> only. <code>active / verify / done</code> are
            engine-owned — drops land nowhere, and the store rejects them server-side too.
          </div>
        </div>
      ) : null}

      <NextPanel
        store={store}
        open={nextOpen}
        onClose={() => setNextOpen(false)}
      />

      {detailEpicId !== null ? (
        epicTree === null ? (
          <CardDetailSkeleton />
        ) : (
          <EpicDetail
            tree={epicTree}
            onOpenStory={(id) => setParam('card', id)}
            onClose={() => setParam('card', null)}
          />
        )
      ) : detailCard === undefined && route.value.card !== null && !store.loaded.value ? (
        <CardDetailSkeleton />
      ) : detailCard !== undefined ? (
        <CardDetail
          card={detailCard}
          actions={detailActions}
          specMarkdown={detailCard.specPath !== undefined ? `spec: ${detailCard.specPath}` : '# no spec yet'}
          {...(detailCard.epicId !== undefined
            ? {
                epic: (store.board.value.epics ?? []).find((row) => row.id === detailCard.epicId),
                onOpenEpic: (id: string) => setParam('card', id),
              }
            : {})}
        />
      ) : null}

      {groomNote !== undefined ? (
        <GroomForm
          noteTitle={groomNote.title}
          {...(api.fetchTypes !== undefined ? { fetchTypes: api.fetchTypes } : {})}
          project={project}
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
          {...(api.fetchTypes !== undefined ? { fetchTypes: api.fetchTypes } : {})}
          project={project}
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
              ...(regroomCard.research?.story !== undefined ? { story: regroomCard.research.story } : {}),
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

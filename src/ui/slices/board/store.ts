import { batch, computed, signal, type Signal } from '@preact/signals';
import {
  type BoardApi,
  type BoardDoc,
  type BoardEvent,
  type GroomInput,
  type Lane,
  type NextDigest,
  type UiCard,
} from './api.ts';
import { pushToast } from '../../components/Toast.tsx';
import {
  findCard,
  optimisticDelete,
  optimisticGroomEdit,
  optimisticMove,
  optimisticRename,
  optimisticReorder,
  withLane,
} from './docTransforms.ts';

// One signals store per project board (D-UI-03): the GET /board document in
// `board`, everything else derived; SSE deltas apply inside one batch() per
// tick; mutations go optimistic → response replace → rollback + toast.
// Zero domain logic — every rule the store enforces visually is enforced
// authoritatively by the server.

export const MANUAL_LANES: ReadonlySet<Lane> = new Set(['todo', 'groomed']);
export const ENGINE_LANES: ReadonlySet<Lane> = new Set(['active', 'verify', 'done']);
// The board document does not expose the server's configured WIP limit
// (frozen API); 3 is the documented default and `atLimit` is confirmed
// authoritatively via GET /next's wipBlockedBy.
export const DEFAULT_WIP_LIMIT = 3;

const EMPTY_BOARD: BoardDoc = {
  lanes: { todo: [], groomed: [], active: [], verify: [], done: [] },
};

export interface FilterState {
  search: string;
  chip: 'all' | 'notes' | 'verbs' | 'tweaks' | 'blocked';
}

export interface FilterState {
  search: string;
  chip: 'all' | 'notes' | 'verbs' | 'tweaks' | 'blocked';
}

export interface WipState {
  active: number;
  limit: number;
  atLimit: boolean;
}

export interface BoardStore {
  readonly project: string;
  readonly board: Signal<BoardDoc>;
  readonly loaded: Signal<boolean>;
  readonly online: Signal<boolean>;
  readonly filter: Signal<FilterState>;
  readonly next: Signal<NextDigest | null>;
  readonly wip: Signal<WipState>;
  /** ids most recently moved by a REMOTE SSE delta (fade-slide cue); cleared shortly after */
  readonly remoteMoved: Signal<ReadonlySet<string>>;
  laneCards(lane: Lane): UiCard[];
  filtered(lane: Lane): UiCard[];
  cardById(id: string): UiCard | undefined;
  setFilter(filter: Partial<FilterState>): void;
  refetch(): Promise<void>;
  fetchNext(): Promise<void>;
  applyEvents(events: BoardEvent[]): void;
  setOnline(online: boolean): void;
  addNote(title: string): Promise<boolean>;
  updateCard(id: string, title: string): Promise<boolean>;
  deleteCard(id: string): Promise<boolean>;
  updateGroom(id: string, input: GroomInput): Promise<boolean>;
  move(id: string, to: Lane): Promise<boolean>;
  reorder(id: string, afterId?: string): Promise<boolean>;
  groom(id: string, input: GroomInput): Promise<boolean>;
  block(id: string, reason?: string): Promise<boolean>;
  unblock(id: string): Promise<boolean>;
  tweak(id: string): Promise<boolean>;
  demote(id: string): Promise<boolean>;
}

export function createBoardStore(project: string, api: BoardApi): BoardStore {
  const board = signal<BoardDoc>(EMPTY_BOARD);
  const loaded = signal(false);
  const online = signal(true);
  const filter = signal<FilterState>({ search: '', chip: 'all' });
  const next = signal<NextDigest | null>(null);
  const remoteMoved = signal<ReadonlySet<string>>(new Set());

  const wip = computed(() => {
    const active = board.value.lanes.active.length;
    const limit = DEFAULT_WIP_LIMIT;
    return { active, limit, atLimit: active >= limit };
  });

  const laneCards = (lane: Lane): UiCard[] => board.value.lanes[lane];

  const matchesFilter = (card: UiCard, state: FilterState): boolean => {
    if (state.chip === 'notes' && (card.verb !== undefined || card.requirement !== undefined)) return false;
    if (state.chip === 'verbs' && card.verb === undefined) return false;
    if (state.chip === 'tweaks' && card.requirement === undefined) return false;
    if (state.chip === 'blocked' && card.blocked === undefined) return false;
    if (state.search !== '' && !card.title.toLowerCase().includes(state.search.toLowerCase())) return false;
    return true;
  };

  const filtered = (lane: Lane): UiCard[] =>
    board.value.lanes[lane].filter((card) => matchesFilter(card, filter.value));

  const cardById = (id: string): UiCard | undefined => {
    const found = findCard(board.value, id);
    return found === undefined ? undefined : board.value.lanes[found.lane][found.index];
  };

  // HTTP is the i/o path of truth for user-initiated actions (D-UI-…):
  // the mutation response replaces state wholesale via refetch. SSE deltas
  // are notifications for changes originated ELSEWHERE — so while a mutation
  // is in flight, its card's deltas are dropped (echo suppression). The
  // response carries no rowid, so the guard is the in-flight window itself,
  // time-boxed as a safety net: suppression ends the moment the response
  // refetch has landed (or ECHO_WINDOW_MS passes, whichever first). A remote
  // change to the same card inside that ≤~200ms window is covered by the
  // response refetch that closes it.
  const ECHO_WINDOW_MS = 2000;
  const echoSuppress = new Map<string, number>(); // cardId → expiry ts
  let mutationsInFlight = 0;

  const isSuppressed = (id: string): boolean => {
    const expiry = echoSuppress.get(id);
    if (expiry === undefined) return false;
    if (expiry < Date.now()) {
      echoSuppress.delete(id);
      return false;
    }
    return true;
  };

  // Mutations: optimistic apply → response replace → rollback + toast on
  // 400/409/404, always naming the card and the server's reason.
  async function mutate(
    id: string,
    optimistic: (before: BoardDoc) => BoardDoc,
    request: () => Promise<unknown>,
  ): Promise<boolean> {
    const before = board.value;
    echoSuppress.set(id, Date.now() + ECHO_WINDOW_MS);
    mutationsInFlight += 1;
    board.value = optimistic(before);
    try {
      await request();
      await refetch(); // server truth replaces wholesale
      return true;
    } catch (error) {
      board.value = before;
      pushToast('error', 'Change reverted', `card ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      mutationsInFlight -= 1;
      echoSuppress.delete(id);
    }
  }

  async function refetch(): Promise<void> {
    try {
      board.value = await api.fetchBoard(project);
      loaded.value = true;
    } catch (error) {
      pushToast('error', 'Board unavailable', error instanceof Error ? error.message : String(error));
    }
  }

  async function fetchNext(): Promise<void> {
    try {
      next.value = await api.fetchNext(project);
    } catch (error) {
      next.value = null;
      pushToast('info', 'deck next', error instanceof Error ? error.message : String(error));
    }
  }

  // SSE deltas — one batch() per tick. Structural fields (lane, position,
  // blocked, tasks) apply from payloads; card.created/groomed/done lack the
  // full row, so they schedule a trailing refetch to fill details. A per-
  // subscription rowid watermark makes replays (reconnect, server resend)
  // never re-apply, and applyEvent itself is idempotent for the same reason.
  let watermark = 0; // highest SSE rowid seen — anything ≤ is a replay
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRefetch(): void {
    if (refetchTimer !== null) return;
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      void refetch();
    }, 50);
  }

  const REMOTE_CUE_MS = 450;
  let cueTimer: ReturnType<typeof setTimeout> | null = null;
  function cueRemoteMove(ids: string[]): void {
    if (ids.length === 0) return;
    remoteMoved.value = new Set(ids);
    if (cueTimer !== null) clearTimeout(cueTimer);
    cueTimer = setTimeout(() => {
      cueTimer = null;
      remoteMoved.value = new Set();
    }, REMOTE_CUE_MS);
  }

  function applyEvents(events: BoardEvent[]): void {
    const cued: string[] = [];
    let needsRefetch = false;
    batch(() => {
      for (const event of events) {
        if (event.rowid <= watermark) continue; // replay of an already-seen event
        watermark = event.rowid;
        const id = typeof event.payload.id === 'string' ? event.payload.id : null;
        // echo of an in-flight local mutation — the response refetch owns it
        if (id !== null && isSuppressed(id)) continue;
        const before = board.value;
        board.value = applyEvent(board.value, event);
        if (
          event.type === 'card.moved' && board.value !== before && id !== null &&
          typeof event.payload.lane === 'string'
        ) {
          cued.push(id);
        }
      }
    });
    // card.created/groomed/done lack the full row → trailing refetch. While a
    // local mutation is in flight its own refetch is imminent and covers the
    // window, so these detail refetches are suppressed to avoid double-apply.
    needsRefetch =
      mutationsInFlight === 0 &&
      events.some(
        (event) =>
          event.type === 'card.created' ||
          event.type === 'card.groomed' ||
          event.type === 'card.done' ||
          event.type === 'card.updated',
      );
    if (needsRefetch) scheduleRefetch();
    cueRemoteMove(cued);
  }

  function applyEvent(doc: BoardDoc, event: BoardEvent): BoardDoc {
    const payload = event.payload as {
      id?: string;
      lane?: Lane;
      position?: number;
      reason?: string;
      tasks?: { title: string; done: boolean }[];
      progress?: string;
    };
    const id = typeof payload.id === 'string' ? payload.id : null;
    if (id === null) return doc;
    switch (event.type) {
      case 'card.moved':
      case 'card.groomed': {
        if (payload.lane === undefined) return doc;
        const found = findCard(doc, id);
        if (found === undefined) return doc;
        const position = typeof payload.position === 'number' ? payload.position : undefined;
        // idempotent replay: same lane, same (or unspecified) position
        if (found.lane === payload.lane && (position === undefined || found.index + 1 === position)) {
          return doc;
        }
        const card = { ...doc.lanes[found.lane][found.index]!, lane: payload.lane };
        const source = doc.lanes[found.lane].filter((entry) => entry.id !== id);
        const base = withLane(doc, found.lane, source);
        const target = [...base.lanes[payload.lane]];
        const insertAt = position === undefined ? target.length : Math.max(0, Math.min(target.length, position - 1));
        target.splice(insertAt, 0, card);
        return withLane(base, payload.lane, target);
      }
      case 'card.tasks.updated': {
        const found = findCard(doc, id);
        if (found === undefined) return doc;
        const lane = doc.lanes[found.lane];
        const updated: UiCard = {
          ...lane[found.index]!,
          ...(payload.tasks === undefined ? {} : { tasks: payload.tasks }),
          ...(payload.progress === undefined ? {} : { progress: payload.progress }),
        };
        return withLane(doc, found.lane, lane.map((entry, i) => (i === found.index ? updated : entry)));
      }
      case 'card.blocked': {
        const found = findCard(doc, id);
        if (found === undefined) return doc;
        const lane = doc.lanes[found.lane];
        const updated = { ...lane[found.index]!, blocked: { reason: payload.reason ?? '', at: new Date().toISOString() } };
        return withLane(doc, found.lane, lane.map((entry, i) => (i === found.index ? updated : entry)));
      }
      case 'card.unblocked': {
        const found = findCard(doc, id);
        if (found === undefined) return doc;
        const lane = doc.lanes[found.lane];
        const { blocked, ...rest } = lane[found.index]!;
        void blocked;
        return withLane(doc, found.lane, lane.map((entry, i) => (i === found.index ? (rest as UiCard) : entry)));
      }
      case 'card.created': {
        if (findCard(doc, id) !== undefined) return doc; // replay/echo — never duplicate
        // stub inserted; trailing refetch fills title/type from the server
        const stub: UiCard = { id, title: id };
        return withLane(doc, 'todo', [...doc.lanes.todo, stub]);
      }
      case 'card.done':
      case 'card.updated':
        // payload carries { id, lane } only — the trailing refetch fills detail
        return doc;
      case 'card.deleted': {
        const found = findCard(doc, id);
        if (found === undefined) return doc;
        return withLane(doc, found.lane, doc.lanes[found.lane].filter((entry) => entry.id !== id));
      }
      default:
        return doc;
    }
  }

  return {
    project,
    board,
    loaded,
    online,
    filter,
    next,
    wip,
    remoteMoved,
    laneCards,
    filtered,
    cardById,
    setFilter: (partial: Partial<FilterState>) => {
      filter.value = { ...filter.value, ...partial };
    },
    refetch,
    fetchNext,
    applyEvents,
    setOnline: (value: boolean) => {
      online.value = value;
    },
    addNote: (title) =>
      mutate('$new', (before) => before, () => api.addNote(project, title)),
    updateCard: (id, title) => mutate(id, (before) => optimisticRename(id, title, before), () => api.updateCard(project, id, title)),
    deleteCard: (id) => mutate(id, (before) => optimisticDelete(id, before), () => api.deleteCard(project, id)),
    updateGroom: (id, input) =>
      mutate(id, (before) => optimisticGroomEdit(id, input, before), () => api.updateGroom(project, id, input)),
    move: (id, to) => mutate(id, (before) => optimisticMove(id, to, before), () => api.move(project, id, to)),
    reorder: (id, afterId) => mutate(id, (before) => optimisticReorder(id, afterId, before), () => api.reorder(project, id, afterId)),
    groom: (id, input) => mutate(id, (before) => before, () => api.groom(project, id, input)),
    block: (id, reason) => mutate(id, (before) => before, () => api.block(project, id, reason)),
    unblock: (id) => mutate(id, (before) => before, () => api.unblock(project, id)),
    // tweak never enters active optimistically — the response is the only
    // path that moves a card into an engine lane (spec: UI never-dos)
    tweak: (id) => mutate(id, (before) => before, () => api.tweak(project, id)),
    demote: (id) => mutate(id, (before) => before, () => api.demote(project, id)),
  };
}

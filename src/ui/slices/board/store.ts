import { batch, computed, signal, type Signal } from '@preact/signals';
import {
  LANES,
  type BoardApi,
  type BoardDoc,
  type BoardEvent,
  type GroomInput,
  type Lane,
  type NextDigest,
  type UiCard,
} from './api.ts';
import { pushToast } from '../../components/Toast.tsx';

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

function findCard(doc: BoardDoc, id: string): { lane: Lane; index: number } | undefined {
  for (const lane of LANES) {
    const index = doc.lanes[lane].findIndex((card) => card.id === id);
    if (index !== -1) return { lane, index };
  }
  return undefined;
}

function withLane(doc: BoardDoc, lane: Lane, cards: UiCard[]): BoardDoc {
  return { lanes: { ...doc.lanes, [lane]: cards } };
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
  laneCards(lane: Lane): UiCard[];
  filtered(lane: Lane): UiCard[];
  cardById(id: string): UiCard | undefined;
  setFilter(filter: Partial<FilterState>): void;
  refetch(): Promise<void>;
  fetchNext(): Promise<void>;
  applyEvents(events: BoardEvent[]): void;
  setOnline(online: boolean): void;
  addNote(title: string): Promise<boolean>;
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

  // Mutations: optimistic apply → response replace → rollback + toast on
  // 400/409/404, always naming the card and the server's reason.
  async function mutate(
    id: string,
    optimistic: (before: BoardDoc) => BoardDoc,
    request: () => Promise<UiCard>,
  ): Promise<boolean> {
    const before = board.value;
    board.value = optimistic(before);
    try {
      await request();
      await refetch(); // server truth replaces wholesale
      return true;
    } catch (error) {
      board.value = before;
      pushToast('error', 'Change reverted', `card ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
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
  // full row, so they schedule a trailing refetch to fill details.
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRefetch(): void {
    if (refetchTimer !== null) return;
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      void refetch();
    }, 50);
  }

  function applyEvents(events: BoardEvent[]): void {
    batch(() => {
      for (const event of events) {
        board.value = applyEvent(board.value, event);
      }
    });
    if (events.some((event) => event.type === 'card.created' || event.type === 'card.groomed' || event.type === 'card.done')) {
      scheduleRefetch();
    }
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
        const card = { ...doc.lanes[found.lane][found.index]!, lane: payload.lane };
        const source = doc.lanes[found.lane].filter((entry) => entry.id !== id);
        const target = [...doc.lanes[payload.lane], card];
        return withLane(withLane(doc, found.lane, source), payload.lane, target);
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
        // stub inserted; trailing refetch fills title/type from the server
        const stub: UiCard = { id, title: id };
        return withLane(doc, 'todo', [...doc.lanes.todo, stub]);
      }
      case 'card.done':
      default:
        return doc;
    }
  }

  function optimisticMove(id: string, to: Lane, before: BoardDoc): BoardDoc {
    const found = findCard(before, id);
    if (found === undefined) return before;
    const card = { ...before.lanes[found.lane][found.index]!, lane: to };
    const source = before.lanes[found.lane].filter((entry) => entry.id !== id);
    return withLane(withLane(before, found.lane, source), to, [...before.lanes[to], card]);
  }

  function optimisticReorder(id: string, afterId: string | undefined, before: BoardDoc): BoardDoc {
    const found = findCard(before, id);
    if (found === undefined) return before;
    const lane = before.lanes[found.lane].filter((entry) => entry.id !== id);
    const card = before.lanes[found.lane][found.index]!;
    if (afterId === undefined) {
      return withLane(before, found.lane, [...lane, card]);
    }
    const anchor = lane.findIndex((entry) => entry.id === afterId);
    const insert = anchor === -1 ? lane.length : anchor + 1;
    return withLane(before, found.lane, [...lane.slice(0, insert), card, ...lane.slice(insert)]);
  }

  return {
    project,
    board,
    loaded,
    online,
    filter,
    next,
    wip,
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

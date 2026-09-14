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

export const MANUAL_LANES: ReadonlySet<Lane> = new Set(['todo', 'groomed']);
export const ENGINE_LANES: ReadonlySet<Lane> = new Set(['active', 'verify', 'done']);
export const DEFAULT_WIP_LIMIT = 3;

const EMPTY_BOARD: BoardDoc = {
  lanes: { todo: [], groomed: [], active: [], verify: [], done: [] },
};

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

  const ECHO_WINDOW_MS = 2000;
  const echoSuppress = new Map<string, number>(); 
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
      await refetch(); 
      return true;
    } catch (error) {
      const latest = board.value;
      const beforeLoc = findCard(before, id);
      const beforeCard = beforeLoc !== undefined ? before.lanes[beforeLoc.lane][beforeLoc.index] : undefined;
      const lanes = { ...latest.lanes } as typeof latest.lanes;
      for (const lane of Object.keys(lanes) as Array<keyof typeof lanes>) {
        const list = lanes[lane];
        const index = list.findIndex((card) => card.id === id);
        if (index === -1) continue;
        lanes[lane] = [...list.slice(0, index), ...list.slice(index + 1)];
        break;
      }
      if (beforeCard !== undefined) {
        const target = beforeCard.lane ?? 'todo';
        const restored = { ...beforeCard };
        const list = [...(lanes[target] ?? [])];
        const pos = restored.position ?? Number.POSITIVE_INFINITY;
        const at = list.findIndex((card) => (card.position ?? Number.POSITIVE_INFINITY) > pos);
        list.splice(at === -1 ? list.length : at, 0, restored);
        lanes[target] = list;
      }
      board.value = { ...latest, lanes };
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

  let watermark = 0; 
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
        if (event.rowid <= watermark) continue; 
        watermark = event.rowid;
        const id = typeof event.payload.id === 'string' ? event.payload.id : null;
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
        const current = doc.lanes[found.lane][found.index]!;
        if (found.lane === payload.lane && (position === undefined || current.position === position)) {
          return doc;
        }
        const card = {
          ...current,
          lane: payload.lane,
          ...(position !== undefined ? { position } : {}),
        };
        const source = doc.lanes[found.lane].filter((entry) => entry.id !== id);
        const base = withLane(doc, found.lane, source);
        const target = [...base.lanes[payload.lane]];
        let insertAt = target.length;
        if (position !== undefined) {
          const neighbor = target.findIndex((entry) => (entry.position ?? Number.POSITIVE_INFINITY) > position);
          insertAt = neighbor === -1 ? target.length : neighbor;
        }
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
        if (findCard(doc, id) !== undefined) return doc; 
        const stub: UiCard = { id, title: id };
        return withLane(doc, 'todo', [...doc.lanes.todo, stub]);
      }
      case 'card.done':
      case 'card.updated':
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
    tweak: (id) => mutate(id, (before) => before, () => api.tweak(project, id)),
    demote: (id) => mutate(id, (before) => before, () => api.demote(project, id)),
  };
}

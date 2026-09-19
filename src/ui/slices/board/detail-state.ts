import { useEffect, useMemo, useState } from 'preact/hooks';
import type { BoardApi, EpicTree, UiCard } from './api-types.ts';
import { route } from '../../router.ts';
import { createBoardStore } from './store.ts';

type BoardStore = ReturnType<typeof createBoardStore>;

/**
 * Resolves which detail dialog is open: the live card from the board store,
 * an epic tree, or a fetched history card when the card is absent from the
 * live lanes. Shared by the board, todo view, and detail rendering.
 */
export function useDetailState(project: string, api: BoardApi, store: BoardStore): {
  epicById: Map<string, { id: string; title: string; stories: number; done: number }>;
  detailCard: UiCard | undefined;
  detailEpicId: string | null;
  historyDetail: UiCard | null | undefined;
  epicTree: EpicTree | null;
  visibleDetailCard: UiCard | undefined;
} {
  // Parent display data for child cards: one lookup from the board's epic
  // rollups, shared by lanes, the todo view, and open detail dialogs.
  const epicById = useMemo(
    () => new Map((store.board.value.epics ?? []).map((row) => [row.id, row] as const)),
    [store.board.value],
  );
  const detailCard = route.value.card !== null ? store.cardById(route.value.card) : undefined;
  // Epic entities open the epic tree (child story rollup), not a flat card
  // detail; rollup matching also covers epics absent from the live lanes.
  const detailEpicId =
    route.value.card !== null &&
    api.fetchEpicTree !== undefined &&
    (detailCard?.type === 'epic' ||
      (detailCard === undefined && (store.board.value.epics ?? []).some((epic) => epic.id === route.value.card)))
      ? route.value.card
      : null;
  const [historyDetail, setHistoryDetail] = useState<UiCard | null | undefined>(undefined);
  const [epicTree, setEpicTree] = useState<EpicTree | null>(null);
  useEffect(() => {
    const id = route.value.card;
    if (id === null || detailCard !== undefined || detailEpicId !== null || !store.loaded.value || api.fetchCardDetail === undefined) {
      setHistoryDetail(undefined);
      return;
    }
    let alive = true;
    setHistoryDetail(null);
    api.fetchCardDetail(project, id)
      .then((card) => alive && setHistoryDetail(card))
      .catch(() => alive && setHistoryDetail(undefined));
    return () => {
      alive = false;
    };
  }, [route.value.card, detailCard, detailEpicId, store.loaded.value, store.boardVersion.value, project, api]);
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
  const visibleDetailCard = detailCard ?? historyDetail ?? undefined;
  return { epicById, detailCard, detailEpicId, historyDetail, epicTree, visibleDetailCard };
}

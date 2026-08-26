import type { BoardDoc, GroomInput, Lane, UiCard } from './api.ts';
import { LANES } from './api.ts';

// Pure BoardDoc transforms shared by the store's optimistic mutations and
// SSE delta application — no signals, no side effects (easy to test, and
// keeps store.ts under the 400-line file cap).

export function findCard(doc: BoardDoc, id: string): { lane: Lane; index: number } | undefined {
  for (const lane of LANES) {
    const index = doc.lanes[lane].findIndex((card) => card.id === id);
    if (index !== -1) return { lane, index };
  }
  return undefined;
}

export function withLane(doc: BoardDoc, lane: Lane, cards: UiCard[]): BoardDoc {
  return { lanes: { ...doc.lanes, [lane]: cards } };
}

export function optimisticMove(id: string, to: Lane, before: BoardDoc): BoardDoc {
  const found = findCard(before, id);
  if (found === undefined) return before;
  const card = { ...before.lanes[found.lane][found.index]!, lane: to };
  const source = before.lanes[found.lane].filter((entry) => entry.id !== id);
  return withLane(withLane(before, found.lane, source), to, [...before.lanes[to], card]);
}

export function optimisticRename(id: string, title: string, before: BoardDoc): BoardDoc {
  const found = findCard(before, id);
  if (found === undefined) return before;
  const lane = before.lanes[found.lane].map((entry) => (entry.id === id ? { ...entry, title } : entry));
  return withLane(before, found.lane, lane);
}

export function optimisticDelete(id: string, before: BoardDoc): BoardDoc {
  const found = findCard(before, id);
  if (found === undefined) return before;
  return withLane(before, found.lane, before.lanes[found.lane].filter((entry) => entry.id !== id));
}

// groom re-edit: verb + title swap immediately (full research/tasks detail
// arrives with the response replace ≤ a refetch later)
export function optimisticGroomEdit(id: string, input: GroomInput, before: BoardDoc): BoardDoc {
  const found = findCard(before, id);
  if (found === undefined) return before;
  const lane = before.lanes[found.lane].map((entry) =>
    entry.id === id ? { ...entry, title: input.refinedTitle, verb: input.proposedVerb } : entry,
  );
  return withLane(before, found.lane, lane);
}

export function optimisticReorder(id: string, afterId: string | undefined, before: BoardDoc): BoardDoc {
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

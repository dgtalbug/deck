// pagerank.ts: dextree's pinned power iteration — α=0.85, tolerance 1e-6,
// max 100 iterations, on the simple-ized directed graph (parallel edges
// collapsed, self-loops dropped because parallel-edge ranking is ambiguous).
// In-memory and dependency-free: deck-scale node counts are tiny.
export function pageRank(nodes: string[], edges: Array<[string, string]>): Map<string, number> {
  const order = nodes.length;
  if (order === 0) return new Map();

  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node, new Set());
  for (const [from, to] of edges) {
    if (from === to) continue; // self-loops dropped
    adjacency.get(from)?.add(to);
  }

  const outbound = new Map<string, number>();
  const inbound = new Map<string, string[]>();
  for (const node of nodes) inbound.set(node, []);
  for (const [from, targets] of adjacency) {
    outbound.set(from, targets.size);
    for (const to of targets) inbound.get(to)?.push(from);
  }

  const ALPHA = 0.85;
  const TOLERANCE = 1e-6;
  const MAX_ITERATIONS = 100;
  let scores = new Map(nodes.map((node) => [node, 1 / order]));
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let danglingMass = 0;
    for (const node of nodes) {
      if ((outbound.get(node) ?? 0) === 0) danglingMass += scores.get(node)!;
    }
    const next = new Map<string, number>();
    let delta = 0;
    for (const node of nodes) {
      let rank = (1 - ALPHA) / order + (ALPHA * danglingMass) / order;
      for (const source of inbound.get(node) ?? []) {
        rank += (ALPHA * (scores.get(source) ?? 0)) / (outbound.get(source) ?? 1);
      }
      next.set(node, rank);
      delta += Math.abs(rank - (scores.get(node) ?? 0));
    }
    scores = next;
    if (delta < TOLERANCE) break;
  }
  return scores;
}

---
name: deck-impact
description: Check what a code change would break BEFORE editing — run deck graph impact/why on every symbol you intend to modify. Use when planning a change, starting a build card, or touching any shared function or class.
allowed-tools: Bash(deck:*)
owns: graph
---

# deck-impact — blast radius before edits

**Compose:** ← deck-build (start of implementation) · ← deck-plan (sizing) · uses deck-lens (audits) · → deck-build (the edits)

## 0. Select

The symbol(s) the planned change will modify — from the card's spec blast-radius section, or the user's naming. If several symbols are candidates, run impact for each. If the user names a concept instead of a symbol, `deck graph search <text>` first, then confirm which symbol before editing.
 If ambiguous, you MUST prompt using the listing commands above — never guess.

## 1. Check state

```bash
deck graph status
```
`ready` → proceed. `absent`/`stale` → `deck graph index` (incremental; a schema bump rebuilds automatically). The graph never gates the engine — a missing graph is a build step, not a blocker.

## 2. Act

1. **Index if needed:** `deck graph index` — reports indexed/skipped counts.
2. **Impact per symbol:** `deck graph impact <symbol>` — the k-hop neighborhood with ring depths and fan-ins. Options: `--in` (callers only), `--out` (callees), `--kinds calls,imports`, `--depth n`.
3. **Upstream focus:** `deck graph why <symbol>` — who reaches this symbol (the review-facing story).
4. **Read the tiers:** `heuristic (0.6)` edges are name-matched, not proven — treat a noisy neighborhood as a hypothesis, verify in the actual call sites before claiming breakage. `unresolved` edges never pose as resolved.
5. **Write the blast radius** into the card's research/spec (files + symbols + ring depth) BEFORE the first edit — every depth-1 caller needs either an update or a stated reason it survives.

### Decision tree (typed errors and refusals)

- `no symbol '<name>' in the graph` → the graph is stale or the name is a concept: `deck graph search <text>` to find the real fqn, then re-run impact.
- `stale — repo origin changed` / `stale — index schema vN ≠ engine vM` → `deck graph index` (auto full rebuild).
- `TRUNCATED` in the output → the neighborhood hit the node cap: narrow with `--kinds calls,imports` or `--depth 1` and re-run.
- index fails on syntax noise → the file is skipped, not fatal; note the file in the spec and continue.

## Laws (this phase)

- Impact before edit — the graph answer precedes the first diff, not the review.
- Heuristic edges (0.6) are leads, not facts; verify in source before claiming a break.
- A `TRUNCATED` flag means the neighborhood hit the node cap — narrow with `--kinds`/`--depth`, don't guess past it.
- The graph never blocks the engine; deleting `.deck/graph.sqlite` is always safe (reindex).

## Output

Per symbol: seed fqn, depth-1 callers/callees with fan-ins, truncated flag, unresolved-edge count. End with the blast-radius list for the spec and: "impact mapped — deck-build edits next."

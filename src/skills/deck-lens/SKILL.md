---
name: deck-lens
description: Run structural audits over the codebase graph — dead code, god functions, god classes, entry points, most/least-used. Use during stabilization audits, pre-archive hygiene passes, or when the user asks what to simplify.
allowed-tools: Bash(deck:*)
owns:
hosts: shell-only contract — Claude Code, GitHub Copilot, and Codex run these recipes through the deck CLI in a shell; no host-native tool syntax is required or claimed
---

# deck-lens — structural audits

**Compose:** uses deck-impact (graph verbs) · → deck-capture (audit findings become notes) · → deck-finish (audit fixes ride the review)

## 0. Select

The audit question: "what's dead?", "what's over-coupled?", "what's the entry surface?", "where's the architecture drifting?" Each maps to one lens. If the user just says "audit", run dead-code + god-function + god-class in that order.
 If ambiguous, you MUST prompt using the listing commands above — never guess.

## 1. Check state

```bash
deck graph status
```
`ready` → proceed. `absent`/`stale` → `deck graph index` first. Audits are read-only — nothing here moves cards or edits code.

## 2. Act

1. **Index fresh:** `deck graph index` (incremental; unchanged files skip).
2. **Run the lenses:**
   - `deck graph lens dead-code` — fan-in 0 AND not an entry point (runtime/handler/test/public-api are excluded by classification, not by fan-in).
   - `deck graph lens god-function` — top 10 by live outbound CALLS fan-out; leaves excluded.
   - `deck graph lens god-class` — top 10 by PageRank importance.
   - `deck graph lens most-used` / `least-used` — fan-in extremes; least-used stays inside the largest connected component.
   - `deck graph lens entry-points` — the classified surface (test > handler > runtime > public-api).
   - `deck graph lens architecture` — every symbol grouped by arch layer.
3. **Search for specifics:** `deck graph search <text>` — FTS5 over symbol names/fqns.
4. **Judge before claiming:** a lens names candidates, not verdicts — cross-check each dead-code hit with `deck graph why <symbol>` and one source read before proposing deletion.
5. **Capture findings:** dead code and god-functions become notes (`deck note "…"`) with the lens output as evidence; fixes ride the normal loop.

## Laws (this phase)

- Audits are read-only — findings become cards, never direct edits.
- Lenses are deterministic (metric desc, id asc) — the same index always yields the same list; rerun after `deck graph index` for fresh truth.
- Heuristic edges are 0.6-confidence leads; dead-code claims need a source-level check before deletion.
- Never delete based on fan-in alone — an entry point at fan-in 0 is still alive.

## Output

Per lens run: count + top entries (fqn, metric). For findings: the note ids captured. End with: "audited — N findings captured; deck-capture shapes them."

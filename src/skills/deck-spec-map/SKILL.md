---
name: deck-spec-map
description: Token-cheap codebase research before proposing or building — graph-first mapping, read slices, never sweep. Use whenever you need to understand code before a deck proposal or implementation.
allowed-tools: Bash(git:*), Bash(grep:*), Bash(deck:*)
owns:
---

# deck-spec-map — graph first, read slices, never sweep

**Compose:** ← deck-capture, deck-explore (they call this discipline) · → deck-capture (findings feed the proposal)

## 0. Select

Scope = the files the user's request plausibly touches. If you cannot name a candidate area after recall + graph search, ask one clarifying question — do not start reading randomly.
 If ambiguous, you MUST prompt using the listing commands in §1 — never guess.

## 1. Check state — graph first, text fallback

```bash
deck recall "<topic keywords>"     # past findings first — free tokens
deck graph status                  # freshness gate: ready | absent | stale | unchecked
deck graph search "<area|symbol>"  # seed symbols for the candidate area
```

- Recall is a lead, not an answer: revalidate every recalled finding against current source (one targeted read or a graph query) before reusing it. Label reused findings `recall-verified` or `stale-recall` in the output.
- `deck graph status` decides the retrieval path:
  - `ready` → map code relationships with graph commands (below).
  - `absent` or `stale` → `deck graph index` only when the research boundary allows an index run (indexing is an explicit build step, never silent, never a blocker); otherwise fall back to text search and say so.
  - `unchecked` or unavailable → fall back to text search and label the output `graph: unchecked`.
- Graph commands for code relationships (each counts against the budget like a read):
  - `deck graph search <text>` — seed symbols/fqns for the area.
  - `deck graph impact <symbol>` / `deck graph why <symbol>` — blast radius and upstream callers whenever the request plausibly touches a shared symbol.
- Text search is the FALLBACK, not the default: `git ls-files | grep -i "<area>"` for candidate files, `grep -rn "symbolOrConcept" src/ --include="*.ts" -l` for file lists. Use it for non-code topics, graph misses, unsupported file types, or absent/stale/truncated graph state — and record that the fallback path was taken.

## 2. Act — the budget

1. **Map before reading.** Seed the symbol map from graph search (+ impact/why for shared symbols); use `grep -nE "^(export )?(async )?(function|class|const [A-Za-z]+ =)" <files>` only on the fallback path or to fill graph gaps.
2. **Read slices, not files.** `sed -n` a range or `grep -n -A8 "<symbol>"` — never `cat` a whole module to find one symbol.
3. **Trust the tiers.** `heuristic (0.6)` edges are name-matched hypotheses — verify in source before claiming a relationship; `unresolved` edges never pose as resolved. A `TRUNCATED` graph answer means narrow (`--kinds`, `--depth`) or fall back — never guess past it.
4. **Hard budget: ≤6 files or ≤3k tokens per research pass** — graph commands, text searches, and source reads all count. Over budget means the request is bigger than assumed — surface that to the user (it predicts a large blast radius, which changes the groom).
5. **Persist everything.** Findings go into the groom proposal's `research.codebaseFindings`; predicted touched files go into `research.blastRadius` — that list becomes the implementing agent's read list, so accuracy here saves the most tokens downstream.

### Blast-radius scale (feeds the spec-type gates)
- ≤3 files — small; minimal spec (title + tasks) is honest.
- 4–7 — normal; findings + blast radius expected.
- ≥8 — large; feat grooms REQUIRE HLD/LLD sections at this size (the registry enforces it — see deck-types).

## Laws (this phase)

- Findings are paid once: if recall answers the question AND revalidates clean, stop reading.
- Graph first for code relationships; text search is a labeled fallback, never the silent default.
- No full-file sweeps, no directory dumps, no re-deriving what the db, graph, or git already knows.
- Never edit code during research — reading only; query commands never index silently.

## Output

Findings list (file:line evidence per finding; recalled findings labeled `recall-verified` or `stale-recall`), the graph freshness state (`ready`/`stale`/`absent`/`unchecked`) and fallback path taken, seed symbols when the graph served the map, tier caveats (heuristic / unresolved / truncated) when present, predicted blast radius (file paths), and the radius verdict (small/normal/large) that deck-capture will need.

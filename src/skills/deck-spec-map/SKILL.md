---
name: deck-spec-map
description: Token-cheap codebase research before proposing or building — map first, read slices, never sweep. Use whenever you need to understand code before a deck proposal or implementation.
allowed-tools: Bash(git:*), Bash(grep:*), Bash(deck:*)
owns:
---

# deck-spec-map — map first, read slices, never sweep

**Compose:** ← deck-capture, deck-explore (they call this discipline) · → deck-capture (findings feed the proposal)

## 0. Select

Scope = the files the user's request plausibly touches. If you cannot name a candidate area after recall + ls, ask one clarifying question — do not start reading randomly.
 If ambiguous, you MUST prompt using the listing commands above — never guess.

## 1. Check state

```bash
deck recall "<topic keywords>"     # past findings first — free tokens
git ls-files | grep -i "<area>"    # candidate files
grep -rn "symbolOrConcept" src/ --include="*.ts" -l   # file list, not file bodies
```

## 2. Act — the budget

1. **Map before reading.** Build a symbol map of candidates: `grep -nE "^(export )?(async )?(function|class|const [A-Za-z]+ =)" <files>`. Read the map, pick the 2–4 files that matter.
2. **Read slices, not files.** `sed -n` a range or `grep -n -A8 "<symbol>"` — never `cat` a whole module to find one symbol.
3. **Hard budget: ≤6 files or ≤3k tokens per research pass.** Over budget means the request is bigger than assumed — surface that to the user (it predicts a large blast radius, which changes the groom).
4. **Persist everything.** Findings go into the groom proposal's `research.codebaseFindings`; predicted touched files go into `research.blastRadius` — that list becomes the implementing agent's read list, so accuracy here saves the most tokens downstream.

### Blast-radius scale (feeds the spec-type gates)
- ≤3 files — small; minimal spec (title + tasks) is honest.
- 4–7 — normal; findings + blast radius expected.
- ≥8 — large; feat grooms REQUIRE HLD/LLD sections at this size (the registry enforces it — see deck-types).

## Laws (this phase)

- Findings are paid once: if recall already answers the question, stop reading.
- No full-file sweeps, no directory dumps, no re-deriving what the db or git already knows.
- Never edit code during research — reading only.

## Output

Findings list (file:line evidence per finding), predicted blast radius (file paths), and the radius verdict (small/normal/large) that deck-capture will need.

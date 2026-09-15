---
name: deck-plan
description: Architect intake — turn one user idea (feature, problem, bug, big bet) into a fully-shaped board plan: epic + stories + tasks, created through engine doors. Use when the user describes something LARGE or multi-part. Planning only — never implement at intake.
allowed-tools: Bash(deck:*), Bash(curl:*)
owns: deps, epic-plan
---

# deck-plan — one idea in, a shaped plan out

**Compose:** uses deck-spec-map (research), deck-types (type law), deck-capture (single-card grooms) · → deck-build (only later, per story, after the user approves) · NOT deck-update (nothing to edit yet)

## 0. Select

This skill fires when the request is plausibly multi-card — big feature, cross-module change, "lets add X to deck". If it is single-concern and small (≤3 tasks), do NOT plan: hand to deck-capture and state "dependencies: none (single-slice)" — small fixes never get epic ceremony. If you cannot tell, research first (deck-spec-map) and then decide. If ambiguous after research, you MUST prompt using `deck board` — never guess a shape.

## 1. Check state

```bash
deck next        # WIP: planning may proceed regardless, but say so if a build holds the slot
deck board       # does an epic for this already exist? epics roll up in deck epics
deck recall "<topic>"   # prior findings — earlier research may already shape this
```

## 2. Act — the architect pass

1. **Research before shaping** (deck-spec-map discipline, ≤6 files + web when the idea is novel). You are looking for: modules touched, prior art, natural seams.
2. **Size by the count law:**
   - ≤3 tasks, one concern → a task card (deck-capture; stop here — its summary says "dependencies: none").
   - >3 tasks → a story: it holds the FULL spec (what & why, findings) and its task list.
   - an idea that decomposes into 3+ stories → an EPIC. Anything that smells like several people-weeks, several modules, or research-then-build is epic-shaped.
3. **Decompose (epic path) — any sound pattern qualifies:**
   - POC first: one story for research + plan (read the codebase, read the internet, propose HLD + LLD as its spec), then implementation stories.
   - Per-module: one story per module/feature, each spec explaining the need, tasks the work.
   - Staged: research → review → planning → test cases as separate stories in order.
   Pick the pattern that fits; state WHY in one line each. 3+ stories or the epic gate flags it. Slices stay PR-sized: one concern, reviewable in one diff.
4. **Create the plan through engine doors only:**
   ```bash
   deck epic "<the idea, one line>"               # → epic id
   deck epic-plan <epicId> intent "<user-visible outcome>" --criterion "<acceptance criterion>"
   deck story <epicId> "<story 1 title>"          # → note id, groom each via deck-capture
   ```
   Repeat `--criterion` per acceptance criterion. Groom every story type-first (deck-types) with its own small spec; story grooms refuse without spec content — that gate is the quality floor. Each story spec carries the SLICE FIELDS:
   - outcome — the small user-visible change this slice delivers (what & why);
   - scope — what is included, and non-goals — what this slice deliberately does not do;
   - acceptance criteria — what a reviewer checks;
   - validation — the command to run or the manual check to perform;
   - ships independently — yes/no. When a slice cannot merge alone without breaking behavior, the spec records WHY and names the slice that must land first (that recorded reason replaces the rationale).
   Stories queue independently: the fan-out point for parallel work IS the epic.
5. **Decide dependencies explicitly — ordering is never implicit:**
   ```bash
   deck deps <story> add <prereq-story>   # only when the prereq must land first (cycle-checked)
   deck deps <story> list                 # shows recorded edges + unmet blockers
   ```
   No edge needed → the plan summary states "no dependency edge required" for that story — the explicit none IS the record.
6. **Map criteria to stories:**
   ```bash
   deck epic <epicId>                              # criteria ids + UNCOVERED flags
   deck epic-plan <epicId> link <criterion-id> <storyId>          # criterion covered by that story
   deck epic-plan <epicId> defer <criterion-id> --reason "<why>"  # not covered by this story set
   ```
   Every criterion ends linked or deferred-with-reason; the summary names uncovered or deferred criteria without claiming the epic complete. When intent edits leave children flagged `[review-needed]`, acknowledge them at the final revision: `deck epic-plan <epicId> ack <storyId>`.
7. **Report the plan as board state:** epic id + intent, each story id · type · tasks · purpose, the slice fields per story, the dependency decision per story (edge or explicit none), criteria coverage (linked · deferred · uncovered), and the recommended build order (research/POC first, then recorded edges). NO card starts here.

## 3. Typed errors you will hit

- `story-shaped (N tasks) without a spec` → write the story spec or split into an epic of smaller cards — the gate is teaching the shape.
- `missing required section(s)` → the chosen type's law (deck-types); fill `research.sections`.
- `epic '<id>' not found` → deck epic lookup miss; check `deck epics` for the real id (bare slugs and legacy ids both work).
- `would create a cycle` → prerequisites must form a DAG; drop or re-point the circular edge (`deck deps <story> remove <prereq>`).
- `prerequisite '<id>' is not a story` → dependency edges reference existing story cards; find the real id via `deck epic <epicId>`.
- `is not a story of epic <id>` → criterion links attach children of that same epic; link the story that belongs to it.

## Laws (this phase)

- Intake plans; it never implements, branches, or starts a card.
- Cards are created ONLY through deck doors (note/epic/story/groom) — never db writes, never lane moves.
- Every story carries its own spec with the slice fields; an epic's plan lives in its stories, not in one giant spec.
- Ordering is explicit — a `deck deps` edge or a stated none; never implied.
- Specs stay ≤350 lines excluding mermaid fences (coming as a type check; keep them small now).

## Output

The plan: epic id + intent + criteria coverage (linked · deferred · uncovered), the story list (id · type · tasks · purpose), per story the slice fields — outcome, scope/non-goals, acceptance criteria, validation, dependency decision (edge or explicit none), ships independently (yes, or why-not + the slice that lands first) — the build order recommendation, and the explicit stop: "planned — approve a story and deck-build starts it."

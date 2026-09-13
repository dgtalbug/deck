---
name: deck-plan
description: Architect intake — turn one user idea (feature, problem, bug, big bet) into a fully-shaped board plan: epic + stories + tasks, created through engine doors. Use when the user describes something LARGE or multi-part. Planning only — never implement at intake.
allowed-tools: Bash(deck:*), Bash(curl:*)
owns: deps, epic-plan
---

# deck-plan — one idea in, a shaped plan out

**Compose:** uses deck-spec-map (research), deck-types (type law), deck-capture (single-card grooms) · → deck-build (only later, per story, after the user approves) · NOT deck-update (nothing to edit yet)

## 0. Select

This skill fires when the request is plausibly multi-card — big feature, cross-module change, "lets add X to deck". If it is single-concern and small (≤3 tasks), do NOT plan: hand to deck-capture. If you cannot tell, research first (deck-spec-map) and then decide. If ambiguous after research, you MUST prompt using `deck board` — never guess a shape.

## 1. Check state

```bash
deck next        # WIP: planning may proceed regardless, but say so if a build holds the slot
deck board       # does an epic for this already exist? epics roll up in deck epics
deck recall "<topic>"   # prior findings — earlier research may already shape this
```

## 2. Act — the architect pass

1. **Research before shaping** (deck-spec-map discipline, ≤6 files + web when the idea is novel). You are looking for: modules touched, prior art, natural seams.
2. **Size by the count law:**
   - ≤3 tasks, one concern → a task card (deck-capture; stop here).
   - >3 tasks → a story: it holds the FULL spec (what & why, findings) and its task list.
   - an idea that decomposes into 3+ stories → an EPIC. Anything that smells like several people-weeks, several modules, or research-then-build is epic-shaped.
3. **Decompose (epic path) — any sound pattern qualifies:**
   - POC first: one story for research + plan (read the codebase, read the internet, propose HLD + LLD as its spec), then implementation stories.
   - Per-module: one story per module/feature, each spec explaining the need, tasks the work.
   - Staged: research → review → planning → test cases as separate stories in order.
   Pick the pattern that fits; state WHY in one line each. 3+ stories or the epic gate flags it.
4. **Create the plan through engine doors only:**
   ```bash
   deck epic "<the idea, one line>"                  # → epic id
   deck story <epicId> "<story 1 title>"             # → note id, groom each via deck-capture
   ```
   Groom every story type-first (deck-types) with its own small spec — story grooms refuse without spec content; that gate is the quality floor. Stories queue independently: the fan-out point for parallel work IS the epic.
5. **Report the plan as board state:** epic id + title, each story id + type + task count + one-line purpose, and the recommended build order (research/POC stories first). NO card starts here.

## 3. Typed errors you will hit

- `story-shaped (N tasks) without a spec` → write the story spec or split into an epic of smaller cards — the gate is teaching the shape.
- `missing required section(s)` → the chosen type's law (deck-types); fill `research.sections`.
- `epic '<id>' not found` → deck epic lookup miss; check `deck epics` for the real id (bare slugs and legacy ids both work).

## Laws (this phase)

- Intake plans; it never implements, branches, or starts a card.
- Cards are created ONLY through deck doors (note/epic/story/groom) — never db writes, never lane moves.
- Every story carries its own spec; an epic's plan lives in its stories, not in one giant spec.
- Specs stay ≤350 lines excluding mermaid fences (coming as a type check; keep them small now).

## Output

The plan: epic id, story list (id · type · tasks · purpose), build order recommendation, and the explicit stop: "planned — approve a story and deck-build starts it."

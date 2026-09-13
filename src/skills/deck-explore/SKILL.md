---
name: deck-explore
description: Read-only tour of deck state — board, epics, memory, issues, next digest. Use before proposing anything, or when the user asks "what's the state / what's next / what's on the board".
allowed-tools: Bash(deck:*), Bash(curl:*)
owns: board, epics, epic, recall, issue, next
---

# deck-explore — read-only state tour

**Compose:** → deck-capture (when the user wants to add work) · → deck-continue (when resuming)

## 0. Select

No target needed — this skill IS the listing. If the user names a card id, jump to the step that reads it; if they name a topic, start at recall. Never mutate anything in this skill.
 If ambiguous, you MUST prompt using the listing commands above — never guess.

## 1. Check state

```bash
deck next        # WIP-aware digest: finish-first card, or top of the groomed queue
deck board       # five lanes + counts (todo · groomed · active · verify · done)
deck epics       # epics with done/total rollups
```

`deck next` outcomes and what they mean:
- `finish first (WIP n/limit)` — an active card owns the build slot; its remaining tasks are in the digest → deck-continue.
- a groomed card's digest — work is queued but not approved; only the user starts it.
- not-found errors — the lanes are empty; the board is yours to fill → deck-capture.

## 2. Act

### Board detail
- `deck board --view todo` — flat todo list instead of lanes.
- One card's issue: `deck issue <id>` — prints the mapped GitHub issue (number, state, labels).
- One epic's tree: `deck epic <epicId>` — stories with lanes, task counts, done/total rollup.

### Memory (project brain)
- `deck recall "<query>"` — FTS5 over session-memory bullets from past cards. Always recall before researching code: past findings are free, re-derivation is not.

### Reading ids
- Card ids are bare three-word title slugs (`dash-load-slow`); collisions number (`-2`). Legacy cards may carry slug+4-char-suffix ids (`verb-registrations-regis-e6ty`) — both are valid lookups everywhere.

### Over HTTP (when the board UI's data is wanted as JSON)
- `curl localhost:3325/<project>/board` — the full board document. Same store, same truth.

## Laws (this phase)

- Read-only: no POST/PUT/PATCH/DELETE, no lane moves, no note creation here.
- `deck next` output is the single source for "what now" — never reason about priority from the board alone.
- Report what you found, not what you would do — proposing belongs to deck-capture.

## Output

A short state summary: lane counts, the next-digest verdict (finish-first / queued / empty), epic rollups if any, recall hits relevant to the user's question, and the hand-off ("ready to capture" / "resume <id>" / "clear to build").

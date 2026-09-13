---
name: deck-update
description: Edit work that has not started — re-groom a groomed card, move/reorder notes, hold/unblock, demote back to note, register verbs. Use when the user changes their mind about queued work.
allowed-tools: Bash(deck:*), Bash(curl:*)
owns: move, reorder, block, unblock, workflow
---

# deck-update — pre-start edits

**Compose:** ← deck-explore (finding the card) · → deck-capture (re-groom content) · stops at start — deck-build owns that door

## 0. Select

Identify the card from context or `deck board`. If the user says "change the spec/tasks of card X" — X must be in `groomed`; active/verify/done cards refuse every edit here (engine lanes).
 If ambiguous, you MUST prompt using the listing commands above — never guess.

## 1. Check state

```bash
deck board                 # lane + id of the target
curl localhost:3325/<project>/cards/<id>   # nothing reads a single card over CLI — board/board view shows state
```

## 2. Act

### Re-groom (new title/tasks/research/type)
Same payload as deck-capture's step 3, but `PATCH`:
```bash
curl -X PATCH localhost:3325/<project>/cards/<id>/groom -H 'content-type: application/json' -d @/tmp/proposal.json
```
Checked task titles survive by name match; the spec versions (v2, v3…) and the draft issue body refreshes on next sync. The spec-type gate applies on re-groom too (missing sections refuse).

### Lane moves humans own
```bash
deck move <id> --to todo      # groomed → todo (un-queue it)
deck move <id> --to groomed   # todo → groomed (manual fast-path; grooming normally does this)
deck reorder <id> [--after <id2>]   # position within the lane
```
`--to active|verify|done` refuses — engine-owned; a user asking for that means `deck <verb>` (deck-build).

### Hold (pick-later) — todo/groomed only
```bash
deck block <id> "waiting on design"   # holds the card out of topOfQueue
deck unblock <id>
```
Hold on active/verify/done refuses (hold is not pause; finish or verify-gaps instead). Legacy engine-lane flags are swept on db open.

### Demote a groomed card back to a note
`curl -X POST localhost:3325/<project>/cards/<id>/demote` — card returns to todo as a note; spec/issue-map/queue rows cascade away; a published draft issue is closed best-effort.

### Register a verb
`deck workflow <new-verb>` — rides the shared engine (start, lanes, hooks) exactly like built-ins.

### Rename / delete (todo/groomed only)
`curl -X PATCH …/cards/<id> -d '{"title":"…"}'` · `curl -X DELETE …/cards/<id>` (cascades map/queue/spec rows; close mapped issues via deck-sync guidance).

## Laws (this phase)

- Humans own todo/groomed only — every engine-lane write here refuses by design.
- Re-groom versions, never forks: one card, one live spec.
- Hold means pick-later — nothing else.

## Output

What changed (card id, lane/field), what refused and why (verbatim typed error), and the card's new state.

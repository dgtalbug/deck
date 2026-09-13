---
name: deck-build
description: Build an approved, groomed deck card — start the verb, implement scoped to the spec with the type's task law, run the verify loop. Use after the user approves a card (deck feat/fix/… <id>) or says "start/build card X".
allowed-tools: Bash(deck:*), Bash(git:*)
owns: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert, tweak, override
---

# deck-build — approved card → code

**Compose:** ← deck-capture (approval) · uses deck-git-conventions (commits) · → deck-finish (close)

## 0. Select

If no card id: `deck next` — but a groomed card in the digest is QUEUED, not approved. Only proceed when the user has approved (they said start/build, or ran the verb). If ambiguous, name the card and ask.
 If ambiguous, you MUST prompt using the listing commands above — never guess.

## 1. Check state

```bash
deck next     # the build digest IS the context: spec path, tasks, branch, issue, ## Type law
```
Load nothing else — the digest carries the spec, tasks, and the type's task law (fix = failing test first, red→green; custom types carry their authored law). Research is already in the spec; do not re-derive.

## 2. Act

1. **Start (the approval act, if not already started):**
   ```bash
   deck <verb> <id>     # e.g. deck fix dash-load-slow
   ```
   Engine: card → active, branch `verb/<first-four-title-words>` (≤32 chars), issue retargeted draft→open. Refusals: `missing required section(s)` → re-groom (deck-update); `branch '…' already exists` → retitle one of the two same-titled cards; WIP limit → finish the named active card first (deck-continue).
2. **Implement on the branch**, scoped by tasks:
   - each requirement's first-four-words slug must appear in a changed file path — name test files after it;
   - dep-touching diffs need a /depend|lock|package/i task title;
   - the fix hard rule: a test file must be in the diff, red→green;
   - `deck.rules.yaml` principles ride the digest (MUST — surface conflicts, never dilute); a user decision is recorded with `deck override <rule-id> --reason "…"` on this card;
   - sync checkboxes through the board as tasks complete (`_source: 'engine'`);
   - capture durable session facts as you go: `deck checkpoint <id> add "<text>" --kind decision|gotcha|remaining|blocker` — the next resume reads them from the digest, so no decision dies with the session.
3. **Verify — the loop, not a formality:**
   ```bash
   deck verify <id>                  # computed: unchecked tasks + unproven requirements are gaps
   deck verify <id> --result gaps    # explicit: you found gaps
   ```
   `gaps` moves the card back to active with the gaps appended as tasks — fix and re-verify. Report `clean` only when verified live in the running app, not just tests green.

## Laws (this phase)

- The digest is the build context — if it reports `context: INCOMPLETE`, make the named direct reads first; no issue-thread dives.
- Never commit to main; commits follow deck-git-conventions.
- Verify-clean HOLDS the card in verify — review + archive close the loop (deck-finish); completion is finalization alone. A tweak's clean completes per tweak policy.

## Output

Card id, branch, tasks checked N/M, verify result, and the hand-off: "built and verified — deck-finish closes it."

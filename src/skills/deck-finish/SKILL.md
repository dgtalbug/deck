---
name: deck-finish
description: Close a built deck card — your own three-dimension verification pass, the mechanical review gate, and archive via PR merge. Use when implementation is done and verified, or the user says review/archive/ship it.
allowed-tools: Bash(deck:*), Bash(git:*)
owns: review, archive
---

# deck-finish — verify → review → archive

**Compose:** ← deck-build · uses deck-git-conventions (merge shapes) · → deck-sync (post-close check)

## 0. Select

The card to close: from context, or `deck next` names the active/verify card. If the user just says "ship it" with multiple candidates, `deck board` and ask. Cards in active or verify close through this skill; done cards are already closed (revert door for regrets).
 If ambiguous, you MUST prompt using the listing commands above — never guess.

## 1. Check state

```bash
deck next                      # the card, its tasks, remaining work
deck review <id>               # the advisory type law prints first, then findings
```

## 2. Act

### Step 1 — your own pass (before the gate)
Report three dimensions; every issue is CRITICAL / WARNING / SUGGESTION:
- **Completeness** — every task checked; every requirement has a paired file (slug law) or a referencing task; no spec'd behavior missing from the diff.
- **Correctness** — scenarios in the spec actually hold; verified live in the running app, not just tests; error paths behave as specced.
- **Coherence** — changes read like the surrounding code; no spec-external scope crept in; blast radius matches the spec's prediction.
CRITICALs block you here — fix and re-verify (deck-build's loop). WARNINGs: fix or justify explicitly. SUGGESTIONs: report only.

### Step 2 — the mechanical gate
```bash
deck review <id>   # must print "review clean — archive is unblocked"
```
Findings and their fixes:
- `requirement "X" has no paired file in the diff` → rename/add files containing the requirement's first-four-words slug (name test files after it).
- `fix requires test pairing` (type law) → the diff must touch a test file, red→green.
- `the diff touches package.json … with no checklist task` → add the pairing task or drop the dep.
- unchecked tasks → actually do them or uncheck honestly via the board.
The gate is never edited or argued with — the diff changes, not the law.

### Step 3 — archive
```bash
deck archive <id>
```
Engine: pushes the branch, PR body = the spec, merges `--no-ff` (`merge: <branch> — <title>` — the revert door's record), card → done, issue closed, branch deleted, changelog entry, tagged release when the diff bumped the version. Refusals: `still queued` → `deck sync` then retry (deck-continue); `no published issue` → the verb never started — deck-build.

### After
`deck sync` should report clean; `deck doctor` all-pass is the resting state (deck-sync owns follow-ups).

Before closing, make the session's knowledge durable: `deck checkpoint <id> add "<what a future session must know>" --kind remaining|blocker` for anything the next card will need.

## Laws (this phase)

- Your pass comes BEFORE the gate — the gate is the floor, not the ceiling.
- Archive is engine-owned: never merge, close issues, or move lanes by hand.
- Warnings you choose to ship are named in your output — silence is how debt hides.

## Output

Three-dimension report (counts per severity + shipped warnings), review verdict, archive outcome (PR url, issue number), and sync state.

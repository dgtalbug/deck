---
name: deck-git-conventions
description: deck's git law as a commit-time runbook — branch naming, commit prefixes, PR body, merge titles, tags, never-main, and the revert door. Use whenever you are about to commit, push, PR, or merge work on a deck card.
allowed-tools: Bash(git:*), Bash(deck:*)
owns:
hosts: shell-only contract — Claude Code, GitHub Copilot, and Codex run these recipes through the deck CLI in a shell; no host-native tool syntax is required or claimed
---

# deck-git-conventions — the commit-time law

**Compose:** ← deck-build (its commits), deck-finish (its merge) · owns no deck commands — pure law + exact sequences

## 0. Select

Applies to any work on a started card. The card's own conventions print in `deck next` (branch, commit prefix from the spec-type registry, merge title). If you do not know the card, `deck board` — the active card owns the branch.
 If ambiguous, you MUST prompt using the listing commands above — never guess.

## 1. Check state

```bash
git branch --show-current     # MUST be the card's branch (verb/first-four-title-words)
deck next                     # the ## Git block: branch, prefix, merge title, tag law
```

## 2. Act

### Branch
- Created by `deck <verb>`: `verb/<first-four-title-words>` (≤32 chars, no card id). Never create it by hand; a duplicate name refuses at start — retitle, don't suffix.
- Check out the card's branch before ANY commit: `git checkout <branch>`.

### Commits
- Subject prefix = the type's `gitConvention.commitPrefix` (default: the verb): `fix: batch DOM writes`, `feat(api): add types route`. Plain conventional-commit shapes, no agent footers.
- One card's work stays on its branch. **NEVER commit to main directly.** No force-push, ever.

### PR + merge (deck-finish drives this — the shapes for reference)
- PR title/body: `merge: <branch> — <card title>`; the body IS the spec (`deck archive` renders it).
- Merge: `--no-ff` with the same title — the merge subject is what the revert door reads.
- Push the branch before the PR; push main after the merge.

### Tags
- Annotated only: `git tag -a vX.Y.Z -m "deck release X.Y.Z"` (the archive tail creates them when the diff bumps the version — don't hand-tag).

### Done was wrong — the revert door
```bash
deck revert <done-card-id>    # generates a NEW groomed revert card
git revert -m 1 <merge-sha>   # on the revert card's branch, per its tasks
```
Then the revert card goes through the normal loop (deck-build). There is no hold on done and no hand-editing of archived cards.

## Laws (this phase)

- Never commit to main; never force-push.
- The merge commit subject is load-bearing (revert door) — never reword it.
- Branches derive from the card; if a branch's title-law name collides, retitle the card, not the branch.
- The db is truth: lanes/state change only through deck doors, never via git surgery.

## Output

The conventions in force for the current card (branch, prefix, merge title) and confirmation the working state complies — or the violation found and its fix.

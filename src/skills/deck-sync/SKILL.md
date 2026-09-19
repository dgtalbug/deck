---
name: deck-sync
description: Flush deck's publish queue and reconcile GitHub issues with the board — drift kinds, their meanings, and their prescribed fixes. Use after archive, when gh was offline, when sync reports drift, or as the end-of-session health check.
allowed-tools: Bash(deck:*), Bash(gh:*)
owns: sync
hosts: shell-only contract — Claude Code, GitHub Copilot, and Codex run these recipes through the deck CLI in a shell; no host-native tool syntax is required or claimed
---

# deck-sync — queue flush + drift reconciliation

**Compose:** ← any skill that hit a queue/drift refusal (deck-continue table points here) · → deck-doctor via onboard for the resting state

## 0. Select

Project from context (`--project`/`DECK_PROJECT` if named). No card selection — sync is project-wide. If the user asks about one card's issue, `deck issue <id>` first, then sync if states disagree.
 If ambiguous, you MUST prompt using the listing commands above — never guess.

## 1. Check state

```bash
deck sync
```
Exit 0 = clean ("queue empty, no drift"). Exit 1 = drift lines — each carries `kind`, `detail`, and its own `fix:`. gh unreachable degrades to a warning, never a failure.

## 2. Act

### The drift table (kind → meaning → prescribed fix)
| Line | Meaning | Fix |
|---|---|---|
| `flush <id> — still queued` | gh was offline; entry stays queued | fix gh auth/remote, re-run `deck sync` |
| `queue flush failed: …` | a broken entry was dropped | the drift section names the card for judgment |
| `[state] issue #N closed but card is not done` | issue closed early (by hand?) | finish + verify the card, or reopen the issue |
| `[state] card is done but issue #N still open` | close failed post-merge | close it on GitHub (`gh issue close N`) |
| `[state] issue #N is still draft but card is active` | groom's draft never retargeted | re-run `deck sync`; if it persists, re-run the verb start |
| `[checksum] spec version is newer than published` | re-groom after publish | `curl -X POST …/cards/<id>/publish` |
| `[label] …` | lane label drifted | sync refreshes labels itself — count only |
| `[missing] orphaned issue / unreadable` | map row lost its card or gh can't read | close the issue on GitHub, then clean the map row |

### Issue lifecycle (why drafts exist)
Groom enqueues a DRAFT publish (label `groomed`, issue_map state `draft`) → `deck sync` flush creates it → `deck <verb>` retargets (body refresh on checksum change, label → lane, state `open`) → archive closes it. Only sync and the verb doors move these states.

### Publish one card explicitly
`curl -X POST localhost:3325/<project>/cards/<id>/publish` — same one-way publish, idempotent by checksum.

## Laws (this phase)

- Sync writes only three things: queue flush, map refresh, label refresh. Drift needing judgment is REPORTED with its fix, never auto-applied.
- Never close/reopen issues by hand to "make sync clean" unless the table's fix says so.
- `sync clean` + `deck doctor` all-pass is the session's resting state.

## Output

Queue depth before/after, flushed issue numbers, drift lines with their fixes (or the fixes you applied per the table), and the resting-state verdict.

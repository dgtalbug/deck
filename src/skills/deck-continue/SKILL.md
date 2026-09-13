---
name: deck-continue
description: Resume a mid-flight deck card or repair a wedged build — deck next as the whole resume context, verify overrides, queued-publish and drift repair. Use when returning to interrupted work or when the engine reports something stuck.
allowed-tools: Bash(deck:*), Bash(git:*)
owns: verify, ops, checkpoint
---

# deck-continue — resume and repair

**Compose:** → deck-build (resume building) or deck-finish (resume closing) · deck-sync (drift), deck-git-conventions (state)

## 0. Select

If the user names a card, that's the target. Otherwise `deck next` picks it for you. If next says not-found, there is nothing in flight — deck-explore for the state tour.
 If ambiguous, you MUST prompt using the listing commands above — never guess.

## 1. Check state

```bash
deck next          # finish-first digest when WIP is held, else the top groomed card
deck board         # which lane the target actually sits in
git branch --show-current && git status --porcelain   # where the worktree stands
```

## 2. Act

### Resume a build
1. Read the digest — it IS the resume context (spec path, tasks with checkboxes, branch, issue, type law, checkpoint). Do not re-research; the spec already carries findings.
2. If the digest carries a `## Checkpoint` section, read it FIRST — it holds the previous session's decisions, gotchas, remaining work and blockers. A checkpoint labeled HISTORICAL is context, not law; the spec and rules above it win.
3. `git checkout <branch>` (dirty tree: commit or stash first — engine verbs refuse dirty trees).
4. Continue tasks; check them off via the board as they complete; then `deck verify <id>` (deck-build owns the loop).

### Capture a checkpoint (your session's durable memory)
When a session makes a decision, hits a gotcha, or must stop mid-card, write it before you lose it:
```bash
deck checkpoint <id>                                     # read the current checkpoint + revision
deck checkpoint <id> add "chose X over Y because Z" --kind decision
deck checkpoint <id> add "watch out: …" --kind gotcha
```
Kinds: decision · gotcha · remaining · blocker. Concurrent writers: pass `--expect-rev <n>` from your last read — a conflict refuses without losing anyone's text. Retries with the same `--id` never duplicate.

### Verify overrides
- You found gaps the computed pass missed: `deck verify <id> --result gaps` — card → active, gaps appended as tasks.
- Explicit clean on a verb: the card HOLDS in verify — review + archive close the loop (deck-finish); a tweak's clean completes per tweak policy.

### Repair — wedged states and their exact fixes
| Symptom | Fix |
|---|---|
| archive refuses `publish … still queued (gh was offline)` | `deck sync` to flush, then retry archive |
| sync: `still queued` after flush | gh unreachable — fix auth/remote, re-run `deck sync` |
| sync drift `draft … but card is active` | re-run the verb start or `deck sync` until the retarget flushes |
| sync drift `closed but card is not done` | finish/verify the card, or reopen the issue on GitHub |
| `deck <verb>` refuses `branch … already exists` | two same-titled cards — retitle one, re-groom |
| card stuck in verify with honest gaps | `deck verify <id> --result gaps` → back to active |
| `deck <verb>` refuses `checkout is owned by operation …` | another build/crash owns the checkout — `deck ops list`, then `deck ops reconcile <id> --confirm|--clean` |
| anything else smells wrong | `deck doctor` — every FAIL names its own fix |

## Laws (this phase)

- The digest is the resume context — if it reports `context: INCOMPLETE`, make the named direct reads before touching code.
- Never unwrap a wedge with lane moves or db edits; the table above are the only doors.
- A converge loop that runs more than twice means the spec is wrong — surface it, re-groom.

## Output

Target card, where it stood (lane, branch, dirty?), what you did (resumed/verified/repaired), and the hand-off (build or finish).

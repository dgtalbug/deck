---
name: deck-finish
description: Close a built deck card — your own three-dimension verification pass, the mechanical review gate, then delivery: prepare (PR) and finalize on observed merge. Use when implementation is done and verified, or the user says review/archive/ship/deliver it.
allowed-tools: Bash(deck:*), Bash(git:*)
owns: review, archive, deliver, policy, delivery, cleanup, evidence, capability
---

# deck-finish — verify → review → prepare → deliver

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

### Step 3 — prepare the delivery
```bash
deck policy <id> --mode team --check <checkId>… --approvals <n>   # once per card (team default; --mode solo is the explicit local opt-in)
deck archive <id>
```
Engine: review + current evidence gates, pushes ONLY the owned branch, opens or reuses the spec-generated PR, records the delivery attempt — the card STAYS in verify with delivery pending. An open PR is never completed work. Refusals: `still queued` → `deck sync` then retry (deck-continue); `no published issue` → the verb never started — deck-build; `no enrolled delivery/evidence policy` → run `deck policy` first; `evidence is not current` → re-run `deck verify`/`deck review` so checks recapture.

### Step 4 — finalize (deck never merges for the team)
```bash
deck deliver <id>            # after the PR is merged on GitHub
deck delivery <id>           # status: pending vs delivered vs refused + cleanup progress
```
Team mode: `deck deliver` reads fresh provider state — it requires the observed merge of the expected PR head/base plus the policy's required checks and approvals, then completes the card once (single done event). `refused` names the unsatisfied condition; fix it or re-prepare. Solo mode: `deck deliver` runs the guarded local `--no-ff` integration into the default branch — local provenance only, no hosted claim.

### Step 5 — cleanup
```bash
deck cleanup <id>
```
Retryable post-delivery follow-ups: issue close, branch delete, one changelog entry, tag-reconciled release. Failures leave the card done and stay inspectable via `deck delivery <id>`.

### After
`deck sync` should report clean; `deck doctor` all-pass is the resting state (deck-sync owns follow-ups).

Before closing, make the session's knowledge durable: `deck checkpoint <id> add "<what a future session must know>" --kind remaining|blocker` for anything the next card will need.

### Cooperative closure doors
- Task ownership transfers only through accepted handoffs (`deck handoff offer/accept`); timeout never transfers.
- Integration of overlapping work names an explicit owner and serializes on the target checkout; conflicts stop for human resolution — neither branch is discarded.

## Laws (this phase)

- Your pass comes BEFORE the gate — the gate is the floor, not the ceiling.
- Delivery is engine-owned: never merge, close issues, tag releases, or move lanes by hand. Deck does not merge team PRs — humans do.
- Warnings you choose to ship are named in your output — silence is how debt hides.

## Output

Three-dimension report (counts per severity + shipped warnings), review verdict, delivery outcome (PR url, issue number, pending/delivered), and sync state.

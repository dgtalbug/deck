---
name: deck-capture
description: Capture a user request as a deck note, research it cheaply, pick the spec type, and groom it into a spec. Use when the user describes something to build, fix, or change. Planning only — never implement in the same run.
allowed-tools: Bash(deck:*), Bash(curl:*)
owns: note, story, groom
---

# deck-capture — request → note → research → typed spec

**Compose:** ← deck-explore · uses deck-spec-map (research), deck-types (type law) · → deck-build (only after the user approves)

## 0. Select

The request that triggered this skill authorizes planning only. Do not edit code, branch, or implement. If the request is vague, ask ONE open question (no preset options) and stop until answered.
 If ambiguous, you MUST prompt using the live listing commands in §1 — never guess. Never skip the §1 candidate scan: a request that matches open work is not new work.

## 1. Check state

```bash
deck next                # respect WIP: an active card may own the slot
deck board --view todo   # open cards (todo + groomed) — the capture candidates
deck types               # the spec-type registry — pick the type BEFORE writing the spec
```

### Candidate scan — mandatory before any `deck note` or groom
1. `deck board` — ids across all five lanes (slug ids read as titles). todo/groomed are live candidates; an active/verify card may already cover the ask.
2. `deck epics` — capability-level overlap; `deck epic <epicId>` when one epic looks close.
3. Read a plausible candidate's detail before deciding: `curl localhost:3325/<project>/board` — the full board document (same store, same truth). Compare outcome, affected area, and acceptance criteria — not wording.
4. `deck recall "<keywords from the request>"` — a done card may already deliver it.

Record exactly ONE decision in your reply before creating anything:
- **reuse** — an open card already covers the request → name its id; create nothing.
- **update** — same work, new information → re-groom THAT card id (`PATCH …/cards/<id>/groom` — POST is note-only); re-groom versions the spec (v2, v3…), it never forks.
- **distinct** — resembles open work but changes the outcome, affected area, or acceptance materially → create new work and state one line why reuse would be wrong.
- **clarify** — may match, but the distinction is unclear → ask ONE open question naming the candidate id; create nothing until answered.

A repeated or retried request defaults to reuse/update — restate the matched id, never re-capture it. If this flow was interrupted and resumed, rerun the scan first and keep the existing card identity where the request is the same.

### Size the ask first (the senior-architect pass)
Before picking a type, size the request like a senior architect — the shape
decision comes before everything, and NO implementation happens here:
- **Small** (one behavior, few files, clear approach): one task card, as below.
- **Big or unclear** (multi-module, needs research, "lets add X to deck"):
  create an EPIC and break it into stories, then groom each story when the
  user is ready:
  ```bash
  deck epic "<the capability>"          # once
  deck story <epicId> "<slice>"         # one per story
  ```
  Breakdown patterns that work: a research/poc story (read the codebase +
  the internet, propose a plan with HLD and LLD), per-module or per-feature
  stories (each explains its needs + tasks), staged stories (research →
  review → planning → test cases). 3+ stories = a proper epic; a story with
  >3 tasks carries the full spec and splits work across task groups.
  Nothing is implemented at this stage — organize and plan only.

Type choice is the shaping decision (see deck-types for the full model):
- bug/symptom → `fix` (requires Reproduce + Root cause sections; test-pairing hard rule)
- new capability → `feat` (HLD/LLD sections required when blast radius ≥8)
- cleanup/tooling → `chore`; docs/style/refactor/perf/test/build/ci as they read
- custom types the registry lists are first-class — read their sections and taskLaw.

## 2. Act

1. **Capture verbatim** — only when the scan decision is `distinct`: `deck note "<user's request, one line>"` → prints the new id (bare slug).
   Epic-scoped: `deck epic "<title>"` once, then `deck story <epicId> "<title>"` per story.
2. **Research** per deck-spec-map (≤6 files): findings → `research.codebaseFindings`, predicted files → `research.blastRadius`.
3. **Groom via the API** — file payload (inline JSON breaks on apostrophes):
   ```bash
   cat > /tmp/proposal.json <<'EOF'
   { "proposedVerb": "fix",
     "refinedTitle": "<one-line imperative title>",
     "research": {
       "story": "<what & why — the spec Story section>",
       "codebaseFindings": ["<file:line evidence>"],
       "blastRadius": ["src/path/file.ts"],
       "sections": { "reproduce": "<how it fails>", "rca": "<root cause>" } },
     "specDeltas": [{ "op": "ADDED", "requirement": "Requirement: <Four Word Name>", "text": "<text>" }],
     "tasks": ["<technical, code-level step>"],
     "openQuestions": [] }
   EOF
   curl -X POST localhost:3325/<project>/cards/<id>/groom -H 'content-type: application/json' -d @/tmp/proposal.json
   ```
   An `update` decision grooms the EXISTING card id with this same payload — first groom of a note is `POST`, an already-groomed card takes `PATCH` on that id. A second note would fork work that belongs on one card.
4. **Typed errors you can hit:**
   - `missing required section(s): …` → the type's gate (deck-types); fill `research.sections` and retry.
   - `verb '…' is not registered` → built-ins or `deck workflow <verb>` names only.
   - `unanswered open questions` → answer them; the server refuses non-empty lists.
5. **Print the contract** any time with `deck groom <id>`.

Requirement names matter: their first FOUR words kebab'd must appear in changed file paths at review time — name test files after the slug. Story/research say WHAT and why; tasks are the only technical section. Minimal spec (title + tasks) is valid for small chore-class work.

Grooming publishes a DRAFT issue on next `deck sync` — the spec is on GitHub from birth, before approval.

## Laws (this phase)

- Planning boundary: stop after groom. The card sits in `groomed`; the user approves.
- Humans own todo/groomed — never move a card forward yourself.
- One issue per change; re-groom versions the spec (v2, v3…), it never forks.
- One decision per capture — reuse, update, distinct, or clarify — recorded with the matched card id, or the reason no match exists.

## Output

The candidate decision first (reuse/update → the matched id · distinct → why · clarify → the open question), then for created or updated work: card id, chosen type + why, requirement names, open questions if any, and: "groomed — `deck <verb> <id>` starts the build once approved."

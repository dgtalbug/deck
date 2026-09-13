---
name: deck-types
description: The spec-type registry — list, author, edit, and remove deck's spec types, and understand the per-type gates and laws. Use when the user wants a custom workflow/type, when grooming fails on missing sections, or to inspect what a type requires.
allowed-tools: Bash(deck:*), Bash(curl:*)
owns: types
---

# deck-types — the spec-type registry

**Compose:** ← deck-capture (type selection), deck-build (task law) · owns the registry itself

## 0. Select

If the user names a type id, that's the target. If they describe a workflow need ("bugs must link an incident"), derive a kebab-case id. If unclear, run `deck types` and show it, then ask.
 If ambiguous, you MUST prompt using the listing commands above — never guess.

## 1. Check state

```bash
deck types    # id · sections(required / ≥N radius) · hard rule, per type
curl localhost:3325/<project>/types    # full rows as JSON
```

## 2. Act

### The model (one read-through covers every error)
A type row: `sections[]` (id, label, `alwaysRequired`, or `requiredAboveRadius` compared against the blast-radius list length), `taskLaw` (free text — ADVISORY: surfaces in `deck review` output and the `deck next` digest, never blocks), `hardRule` (mechanical; today only `test-pairing` = the diff must touch a test file or review refuses), `gitConvention.commitPrefix` (defaults to the type id). Registry rows are read at call time — edits apply on the next command, no restart.

Built-in seeds: `fix` = reproduce+rca always required + test-pairing; `feat` = hld+lld at radius ≥8; everything else minimal. Seeds are ordinary rows — editing them is supported.

### Create / edit
```bash
cat > /tmp/type.json <<'EOF'
{ "id": "hotfix", "displayName": "hotfix", "icon": "flame",
  "sections": [{ "id": "incident", "label": "Incident", "alwaysRequired": true }],
  "groomFields": ["story"], "taskLaw": "link the alert in the story",
  "gitConvention": {}, "hardRule": null }
EOF
deck types new /tmp/type.json        # or: curl -X PUT localhost:3325/<project>/types -d @/tmp/type.json
```
A new id needs its verb registered before grooms can use it: `deck workflow <id>`.

### Remove
`deck types remove <id>` — refuses while any card uses the type, naming the dependent cards. Cards survive; retype or delete them first.

### Typed errors you will hit
- `groom proposal … missing required section(s): X, Y` → fill `research.sections.X/Y` in the groom payload (deck-capture carries the shape). Same refusal fires at `deck <verb>` if the registry was tightened after groom — re-groom.
- `spec type '…' is in use by N card(s)` → removal blocked; retype the cards first.
- `hard rule '…' is unknown` → only `test-pairing` exists; free-text enforcement is not a thing — taskLaw is advisory by design.

## Laws (this phase)

- hardRule is an enum, never free text — deck computes what it enforces, surfaces the rest.
- Deleting a type never deletes its cards.
- Built-in edits are allowed and live immediately; the groom + start doors re-check.

## Output

The type table (or the saved row), what changed, and which gates now apply to the next groom of that type.

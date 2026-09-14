## Context

See proposal.md. `src/core/board/specstore.ts` stores immutable rendered versions per card, not a project capability model. `scope.ts` supplies stable IDs and revision digests; it must not be assumed to contain full historical text when only digests/operations were persisted. `engine/evidence.ts` records attributed results and execution fingerprints; `engine/delivery.ts` records policy/scope and hosted/local completion provenance. These records need source revalidation, not a fresh completion call during export. E06 currently has dirty schema/store changes; preserve them and integrate only after checking their landed contracts.

## Goals / Non-Goals

Export an inspectable local artifact and derive attributable capability views. Keep the database authoritative per `.meta/sdd-engine.md`. Existing OpenSpec backfill and provider publication are separate commands; neither runs from export or projection. No agent inference, remote reads, automatic semantic merge or arbitrary file traversal is necessary.

## Decisions

### D1 — Portable schema and consistent snapshot

JSON is authoritative; Markdown is a deterministic rendering, not a second editable source or Markdown import format. Version 1 contains project identity, selected epic, source snapshot digest, epics/stories keyed by stable IDs, criterion/task references, scope and parent revisions, selected decisions, evidence records, delivery/policy references, artifact metadata, and explicit omissions. Retain source timestamps; optional export time is excluded from the canonical content digest. Stable sort by IDs/revisions, deterministic JSON serialization and stable Markdown anchors give reproducible output.

Read related rows in one SQLite read transaction, include historical work regardless of E08 visibility, and copy only selected source excerpts after verifying recorded digests. If a historical text/revision is unavailable, represent it as unknown; never substitute current text under an old revision. Dangling references get explicit unresolved records. Each entity appears once, other occurrences use stable links. Preserve evidence result independently from freshness and delivery assurance: a recorded pass can now be stale, and a solo completion remains local assurance. The bundle is a snapshot of recorded observations, not live provider certification.

Use an explicit versioned schema with namespaced extension object; preserve supported unknown extension JSON during parse/serialize, report unknown root fields as unsupported instead of silently dropping them, and reject unsupported major versions. Round-trip means JSON parse/serialize preserves IDs, provenance, statuses and extensions; no board import or provider adapter is included.

### D2 — Safe local surfaces

Proposed additive CLI: `deck evidence export <epic-id> --out <directory>` and `deck evidence view <bundle.json>`. Export writes bundle.json and review.md to a new local directory via staging/rename; existing output refuses overwrite. A failed export leaves no apparently complete bundle. Viewer validates local JSON, is read-only, renders through existing sanitized UI helpers and never fetches artifact URLs automatically. Add a local epic evidence view over the same model through the existing project routes and UI detail navigation. Only allow safe link schemes; escape Markdown/HTML and treat source excerpts as untrusted content.

Default allowlist includes relevant scope text, explicitly selected decision excerpts, evidence status/identity/digests/timestamps and safe PR/diff links. Exclude raw command strings, raw logs, environment/config values, absolute machine paths and checkpoint bodies. Report omitted fields with reasons. Artifact references use stable IDs and project-relative paths only where safe; do not dereference them. User-authored scope can itself contain sensitive text: label export as local review and let the user inspect before sharing; do not promise automatic secret detection. No external write or browser network fetch is part of export/view.

### D3 — Explicit capability deltas

Persist capability identity and ordered add/modify/remove deltas as new derived metadata, separate from story criteria. Each operation has a stable delta ID, capability/statement ID, expected prior statement digest (absent for add), exact proposed text (none for remove), source story/criterion/revision and evidence/delivery references. Never infer add/modify/remove from prose. CLI accepts a validated local delta JSON file in preview; capability IDs are logical names, never filesystem paths.

Only exact criterion text from the validated source revision can be used as current statement text. Broader human paraphrases require a new accepted source revision rather than silently extending completed scope. All descriptive text in the capability output is either a neutral generated label or links to source-backed statements. Removal retains a lineage tombstone. A capability statement identity can link multiple historical criterion IDs without assuming matching titles mean identity.

### D4 — Completion eligibility and conflicts

Preview joins the specific delivered record with its exact scope revision, policy version, evidence and completion transaction facts. It does not call finalization or rerun checks. A done lane or checked task alone is insufficient. Missing historical policy/scope/evidence association produces unknown/ineligible, not reconstructed success. At apply time revalidate the preview source digest, source eligibility and capability base revision in the same transaction. Current reopened/changed source is ineligible for a new projection; prior valid completed revisions remain immutable history, with current source drift visibly marked for review. A new policy version does not retroactively falsify an old validated completion; its original policy must be attributable.

Apply operations in explicit order supplied by the reviewed preview. Same statement changed by competing deltas, missing expected base, duplicate add, remove of absent target, or incompatible rename stop the entire batch with a conflict preview. No last-write-wins. Resolve by selecting/reordering source-backed deltas or preparing new accepted scope; record actor and resolution rationale. Preview cannot mutate current capabilities. Backfill uses this same explicit preview/accept workflow and cannot waive missing completion proof.

### D5 — Persistence, retries and rollback

Proposed CLI `deck capability preview <delta-file>` returns a content-addressed preview ID with exact diff, conflicts, omissions, base and source digests; `deck capability apply <preview-id>` explicitly accepts it. Persist preview content locally so apply does not read changed input files. Store immutable projection versions and applied delta IDs with a unique transaction identity; atomic compare-and-swap current pointer. An identical retry returns the existing result; changed content with reused delta ID refuses. Concurrent applies conflict without partial statements or history writes.

Rollback is an explicit new projection version referencing a previously accepted version; it does not delete versions or alter source scope/evidence. Preview warns of subsequent statements removed by rollback, and acceptance uses the same base guard. Derived versions remain rebuildable from stored accepted deltas. Read views mark unavailable/drifted source references without silently rewriting accepted history. Do not write `openspec/specs/`: this local projection is an attributable derived view, not a competing authoring authority.

## Risks / Trade-offs

- Historical completion association may be incomplete → fail closed for projection, export explicit unknowns; do not backfill guesses.
- Capability mapping adds authoring work → explicit small delta files avoid semantic merger machinery and are reviewable.
- Offline links can be unavailable → embed IDs/statuses and selected scope, distinguish external links from packaged facts.
- Existing UI size limit → lazy-load evidence/projection review surfaces using current sanitized rendering.
- E08 history and E06 canonical stores can land concurrently → use canonical project identity and inclusive reads; revalidate before apply.

## Migration Plan

Ship DECK-ARCH-027 read-only export/view first. Add projection metadata with existing schema/old-writer guards for DECK-ARCH-028, without modifying historical spec/evidence rows. Default is no applied capabilities. Preview selected legacy records, require attributable completion, then explicitly accept eligible deltas. Rollback feature deployment disables new projection writes; original records and exported bundles remain readable. Test migration refusal, preview/apply concurrency, repeated retry and rollback history equivalence. No runtime acceptance is established by this plan.

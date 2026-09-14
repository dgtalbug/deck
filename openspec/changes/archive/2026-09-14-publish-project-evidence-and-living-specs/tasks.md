## 1. Prerequisites and integration

- [x] 1.1 Revalidate E02 checkpoint, E03 scope/parent and E05 delivery/policy/evidence persistence in `src/core/board/` and `src/core/engine/`; record exact historical proof availability in `notes.md` and refuse unsupported projection rather than infer it.
- [x] 1.2 Check current E06 canonical-store and E08 history interfaces before implementation; record caller/impact results from `deck graph impact` in the implementation card spec before editing symbols, preserving concurrent work.

## 2. DECK-ARCH-027 — Portable evidence and local review

- [x] 2.1 Add versioned evidence-bundle types/validation in `src/core/board/evidence-bundle-schema.ts`; tests cover stable IDs, status/freshness separation, safe extensions and unsupported versions/fields.
- [x] 2.2 Add consistent snapshot collection in `src/core/board/evidence-bundle.ts` over scope, parent, spec, evidence and delivery readers; fixtures cover shared links, historical work and missing exact revision text.
- [x] 2.3 Add deterministic JSON serialization and canonical digest in the bundle core; parse/serialize fixtures prove identity, provenance and extension preservation with explicit unsupported-field reporting.
- [x] 2.4 Add Markdown rendering in `src/core/board/evidence-bundle-render.ts`; golden fixtures prove stable anchors, selected decisions, criterion-to-result traceability and explicit failed/unknown/stale/omitted fields.
- [x] 2.5 Implement safe export allowlist and reference normalization in bundle helpers; tests exclude raw commands/logs, checkpoint bodies, absolute paths and unsafe links without dereferencing files or invoking providers.
- [x] 2.6 Add `deck evidence export` dispatch in `src/cli/` and atomic new-directory output; CLI tests cover existing destination refusal, write failure and complete offline output.
- [x] 2.7 Add shared read-only local evidence route and `deck evidence view` bundle loading in `src/server/` and `src/cli/`; validate inputs and test malformed bundles and zero external effects.
- [x] 2.8 Add lazy evidence view under `src/ui/slices/` with existing sanitized rendering; browser tests cover offline review, safe links, gaps and hosted-versus-local assurance.
- [x] 2.9 Record an offline reviewer walkthrough in `notes.md` using the exported fixture alone; reviewer traces one criterion to evidence and delivery without chat, and records any unsupported loss before proceeding to projection.

## 3. DECK-ARCH-028 — Attributable capability projection

- [x] 3.1 Add capability/delta/preview/version metadata in `src/core/board/schema.ts` and current migration module; tests preserve existing scope/spec/evidence and verify incompatible-writer refusal.
- [x] 3.2 Add delta input schema and source-lineage validation in `src/core/board/capability-deltas.ts`; tests cover add/modify/remove, stable IDs, invalid references and refusal of unsourced statement text.
- [x] 3.3 Add pure completion eligibility reader in `src/core/board/capability-eligibility.ts`; tests distinguish team/solo proof, original policy versions, legacy unknowns, reopened work and unavailable exact scope.
- [x] 3.4 Add ordered preview/diff/conflict core in `src/core/board/capability-projection.ts`; tests cover duplicate add, absent removal, prior digest mismatch and competing statement changes without semantic merging.
- [x] 3.5 Persist content-addressed previews and explicit resolution attribution in projection helpers; tests prove preview has no current-state effect and changed input files cannot alter accepted preview content.
- [x] 3.6 Implement atomic apply with source/base revalidation and unique delta/batch identities in projection core; concurrency/crash/retry tests prove no partial writes or duplicate versions and reject changed content under reused IDs.
- [x] 3.7 Implement rollback preview/new-version apply and source-drift read status in projection core; fixtures prove previous history and source/evidence bytes remain unchanged.
- [x] 3.8 Add `deck capability preview` and `deck capability apply` dispatch in `src/cli/` with local-only errors; CLI tests verify explicit acceptance, stale-preview refusal and no provider/OpenSpec file writes.
- [x] 3.9 Add local capability read/preview navigation under `src/server/` and `src/ui/slices/`; reviewer smoke verifies each current statement/removal links to source and that unresolved conflicts cannot appear applied.
- [x] 3.10 Exercise selected legacy preview/backfill fixtures in `tests/core/board/`; prove missing completion cannot be waived and accepted historical deltas use the same transaction/lineage contracts.

## 4. Acceptance and guidance

- [x] 4.1 Document local export schema, omissions, commands and derived capability authority in project guidance; record manual projection-format acceptance in `notes.md` and keep internal planning references out of source comments.
- [x] 4.2 Run `bun test` and repository type/build checks for changed surfaces; verify lazy UI additions preserve existing core bundle limits and record exact commands/results.
- [x] 4.3 Complete the requirement matrix in `notes.md`, strict-validate OpenSpec and update task evidence; retain unchecked tasks for missing reviewer proof or runtime failures.

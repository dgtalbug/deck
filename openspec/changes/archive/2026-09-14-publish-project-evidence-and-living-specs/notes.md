# E09 planning and acceptance

Planning only: no product edits, live provider calls, export trials, runtime tests or reviewer acceptance performed. E06 currently has unrelated dirty product files; they were preserved. E05 delivery/evidence code is present and its change no longer appears in the active list, but these observations do not establish prerequisite correctness. Apply must verify its persisted proof contracts.

Authority: roadmap §E09; detailed backlog DECK-ARCH-027 (depends 010/012/015) and 028 (depends 011/014/027); `.meta/sdd-engine.md` database authority/one-way publishing and `.meta/ui-decisions.md` rendering/bundle constraints. Story 027 ships and is reviewed before 028. No external writes or automatic OpenSpec main-spec edits. The source comment rule remains in effect.

## Acceptance matrix

| Requirement | Original story criteria | Implementation | Verification |
|---|---|---|---|
| Evidence export preserves lineage | 027 IDs, scope/parent revisions, tasks/decisions, links, failed/unknown/stale, exactly-once entities | 2.1–2.4 | 2.2–2.4, 2.9, 4.2 |
| Portable parsing reports loss | 027 schema/version, deterministic round trip, unknown extensions/loss | 2.1, 2.3 | 2.1, 2.3, 4.2 |
| Local review is safe and self-contained | 027 offline criterion tracing, no external writes, selected excerpts, missing PR valid, safe output | 2.4–2.8 | 2.5–2.9, 4.1–4.2 |
| Projection requires attributable completion | 028 policy-validated completion, every statement/source lineage, no guessed historical proof | 3.2–3.3 | 1.1, 3.2–3.3, 3.10, 4.2 |
| Conflicts require explicit preview acceptance | 028 ordered add/modify/remove, conflict stop, explicit resolution, stale/concurrent safety | 3.4–3.6, 3.8–3.9 | 3.4–3.6, 3.8–3.9, 4.1–4.2 |
| Projection retries and history are immutable | 028 retry/rollback, unchanged source history, previewed accepted backfill | 3.1, 3.6–3.8 | 3.1, 3.6–3.10, 4.2 |

## Design choices recorded

JSON is the portable source and Markdown a rendering. Round trip does not mean importing changes into Deck. Living specs are local derived database projections with explicit source-backed deltas, not automatic OpenSpec merging. Historic incompleteness stays unknown. Original policy validity and current source drift are separate facts. Rollback appends a version. Reader evidence and projection-format acceptance remain explicit manual tasks, while deterministic contracts receive automated fixtures.

## Verification record

Initial planning validation and task/requirement mapping were the only checks performed when this plan was authored. Apply verification below is local-only proof from tests, typecheck, build and local CLI/server/UI behavior; it is not hosted/deployed proof and includes no provider read-back claim.

## Apply record

### 2026-09-14 prerequisite revalidation

Task 1.1 verified the current persisted proof contracts before projection implementation:

- E02 checkpoint context is present as `CheckpointEntry.basis`, with `checkpointBasis(scopeRevision, sourceRevision)` producing `scope:<revision>:<source-digest>` when both scope and source revision are known. `checkpointProvenance()` distinguishes `current`, `historical` and `unknown`; export may report checkpoint provenance, but must not export checkpoint bodies by default.
- E03 scope identity is present as stable criterion IDs in `scope_items`, task IDs in `tasks`, card-to-epic parent links on `cards.epic_id`, and scope revisions in `scope_revisions`. `recordScopeRevision()` persists a digest and operation list, not a complete historical text snapshot; exact historical text availability must be checked from persisted versions before export or projection.
- E05 evidence persistence is present in `evidence_records`, including criterion/task/check identity, result, command digest, scope revision, policy version, base/head SHA, input fingerprint/coverage and optional artifact fingerprint or unavailability. Evidence result is not the same as current freshness.
- E05 delivery persistence is present in `deliveries`, including mode, policy version, scope revision, input fingerprint, PR/link fields, merge metadata, hosted/local provenance, state and refusal reason. `finalizeDelivery()` and solo finalization revalidate scope, policy and current evidence before marking delivered.
- Historical proof availability is therefore mixed: recorded digests, revisions, results, policies, delivery provenance and safe link metadata can be exported; exact historical source text, raw command output, checkpoint bodies and any unavailable artifacts cannot be inferred. Projection must refuse unsupported historical completion instead of substituting current text or treating done/checklist state as proof.

Task 1.2 checked current canonical-store and history interfaces:

- Canonical store identity for published specs uses `canonicalProjectId(store)` and `markerFor(...)` from `specstore.ts`/provider operations; issue maps and publish queue remain card keyed and checksum based.
- Spec versions persist rendered immutable markdown blobs plus checksums in `specs`; this supports evidence linking, but is not a structured capability model.
- History uses `historyAt` retention in `cards`, inclusive live/history reads via `history.ts`, and retention selection that hides completed work only after completion/cleanup/in-flight guards. Export must include historical children rather than reading only live board lists.
- Graph impact checks before product edits found these symbols indexed with depth-0 neighborhoods: `src/core/board/checkpoint.ts:readCheckpoint`, `src/core/board/scope.ts:recordScopeRevision`, `src/core/engine/evidence.ts:evaluateEligibility`, `src/core/engine/delivery.ts:recordDeliveryAttempt`, `src/core/board/specstore.ts:specs`, and `src/core/board/history.ts:retentionSelection`. Broad lookups for `checkpoint`, `scope` and `evidence` did not resolve as symbols; `delivery` resolved only to `tests/engine/delivery-policy.test.ts:delivery`.

### 2026-09-14 offline reviewer walkthrough

Task 2.9 exported the current local board epic `epic` with:

`bun run src/cli/main.ts evidence export epic --out /tmp/deck-evidence-walkthrough-2026-09-14`

Then loaded only the exported bundle with:

`bun run src/cli/main.ts evidence view /tmp/deck-evidence-walkthrough-2026-09-14/bundle.json`

The offline artifact rendered a deterministic `deck.evidence-bundle@1.0.0` review for project `project:9a8a968d4bd6bfee`, snapshot `5fef90f22b8cd8450b6d106d220bd33b0434eebf5842aac8bae2ac5a0a5cf4b6`, and epic `epic:epic` ("Make deck a trusted open-source project with repeat adoption"). It also showed explicit omissions for checkpoint bodies and raw commands.

Unsupported loss recorded: this live epic currently has no stories in the local board, so the walkthrough cannot trace a criterion to evidence and delivery from this artifact. That absence is represented as empty Stories/Evidence/Deliveries sections rather than a success claim. Projection must not proceed from this fixture as completed capability proof.

### 2026-09-14 projection apply and rollback

Task 3.7 followed a regression fix in `applyCapabilityPreview()`: preview state updates now target the active preview row by ID, so accepting or staling one stored preview does not mutate sibling previews.

Rollback preview/apply now derives a new preview from a prior accepted projection version, applies it through the same guarded preview acceptance path, and appends a new projection version instead of editing historical rows. The focused fixture verifies the prior version rows, including source/evidence/delivery lineage fields, remain byte-for-byte unchanged after rollback, while current read status reports source drift from supplied current source revisions.

Focused checks:

- `bun test tests/core/board/capability-apply.test.ts`
- `bun test tests/core/board/capability-preview-persistence.test.ts`
- `bun test tests/core/board/capability-preview-persistence.test.ts tests/core/board/capability-projection.test.ts`

Task 3.8 added local `deck capability preview <delta-file>` and `deck capability apply <preview-id> --accept` dispatch. Preview files must carry explicit source excerpts and eligibility records alongside deltas; the command persists previews locally, emits JSON, requires explicit apply acceptance, and does not create OpenSpec artifacts or provider operations in the tested project.

Focused check:

- `bun test tests/cli/capability.test.ts`

Task 3.9 added local read routes for applied capability statements and stored previews, plus an on-demand epic detail panel for current statements and preview inspection. The smoke fixture shows current statements with source/evidence/delivery lineage, loads conflicted previews separately, and verifies conflicted preview text does not appear as applied before preview navigation.

Focused checks:

- `bun test tests/server/capability-routes.test.ts` (required local bind permission in this sandbox)
- `bun test tests/ui/carddetail.test.tsx`
- `bun test tests/core/board/capability-apply.test.ts tests/core/board/capability-preview-persistence.test.ts tests/core/board/capability-projection.test.ts`

Task 3.10 added legacy/backfill fixtures proving missing historical completion proof remains ineligible and cannot be waived by preview. Accepted historical deltas now preserve source criterion, scope revision, evidence and delivery lineage in both current statements and applied delta rows, using the same persisted preview and atomic apply path as non-legacy projection.

Focused checks:

- `bun test tests/core/board/capability-legacy-backfill.test.ts`
- `bun test tests/core/board/capability-apply.test.ts tests/core/board/capability-preview-persistence.test.ts tests/core/board/capability-projection.test.ts tests/cli/capability.test.ts`

### 2026-09-14 guidance and projection-format acceptance

Task 4.1 documented the local export schema, omissions, commands and derived capability authority in `README.md`. Manual projection-format acceptance: reviewed CLI JSON output fields (`previewId`, state, changes, conflicts, base/source/content digests) and UI/server preview separation; the format is accepted for local review because unresolved conflicts remain preview-only and applied statements retain source/evidence/delivery lineage. This is not acceptance of hosted publication or OpenSpec spec-file mutation.

Source-comment scan:

- `rg -n "OpenSpec|DECK-ARCH|E0[0-9]|publish-project-evidence|task [0-9]|agent attribution|implementation diary" src tests | head -100`

Result: matches are pre-existing historical test comments; no new source comments were added for this change slice.

### 2026-09-14 repository verification

Task 4.2 verification is local-only. The first broad `bun test` run inside the sandbox failed from environment constraints: local server tests could not bind ephemeral ports and git fixture commits inherited host git configuration. Rerunning with local bind permission and isolated git config produced a clean suite:

- `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 bun test` — 1112 pass, 0 fail, 3845 expect calls, 198 files.
- `bun run typecheck` — `tsc --noEmit`, pass.
- `bun test tests/core/board/evidence-bundle.test.ts tests/core/board/capability-apply.test.ts tests/ui/carddetail.test.tsx` — 15 pass, 0 fail for non-server focused slices after type fixes.
- `bun test tests/server/capability-routes.test.ts` — 2 pass, 0 fail with local bind permission.
- `bun run build` — pass; UI bundle core total 46.3 kB gz against 100 kB budget, embedded UI and migrations regenerated, compiled `deck`.
- `openspec validate publish-project-evidence-and-living-specs --strict --no-interactive` — pass.

No hosted/deployed verification was performed. The evidence is local tests, local CLI/server behavior and local build output only.

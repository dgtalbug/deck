Make project evidence portable and completed capability changes readable with preserved provenance.

## Why

This spec-level change implements roadmap §E09 in `docs/research/deck-pm-epic-roadmap-2026-09-13.md`, retaining DECK-ARCH-027 and 028 from the unified architecture backlog. Reviewers currently need to reconstruct lineage across per-card versions, evidence and delivery records. Prerequisites are E02 checkpoint context, E03 stable scope/parent identities, and E05 policy-validated completion.

## What Changes

- Export deterministic, versioned JSON and Markdown evidence bundles with an offline local review view.
- Preserve criterion/task IDs, scope and parent revisions, selected decisions, evidence results and available delivery links; represent missing, failed and stale information explicitly.
- Preview attributable capability deltas and apply only those supported by validated completion.
- Require explicit conflict resolution, protect against stale previews, and retain immutable projection history with idempotent retries.

## Capabilities

### New Capabilities

- `spec/evidence-bundle`: Portable evidence schema, export and local review.
- `spec/living-capabilities`: Explicit capability deltas, guarded projection and historical lineage.

### Modified Capabilities

None. Existing publication, completion and OpenSpec backfill contracts remain separate.

## Impact

Board scope/spec/evidence readers, new local export/projection cores, CLI and local UI/routes, migration and fixture tests. Follow `.meta/sdd-engine.md` database authority and one-way publication, and `.meta/ui-decisions.md` sanitized rendering and bundle limits. Revalidate current completion records before apply; preserve concurrent collaboration work.

## Non-goals

External publication, Jira adapters, imported-bundle execution, automatic semantic merging, cross-repository capabilities, raw log/secret export, rewriting historical scope, or automatic edits to `openspec/specs/`.

# spec/evidence-bundle — portable project evidence

## Purpose

Provide portable project review evidence with stable identity and explicit provenance, gaps and assurance.

## Requirements

### Requirement: Evidence export preserves lineage

The system SHALL export versioned JSON and a deterministic Markdown rendering from a consistent project snapshot. Each referenced story, criterion, task and evidence record SHALL appear once or through a stable link. Scope/parent revisions, selected decisions and available delivery links SHALL remain attributable. Missing, failed, unknown and stale statuses SHALL remain explicit, independently of recorded result and hosted/local assurance.

#### Scenario: Complete fixture

- **WHEN** an epic with shared references and historical children is exported
- **THEN** all referenced entities and revisions are traceable without duplicate entity records

#### Scenario: Missing history

- **WHEN** exact historical scope or evidence is unavailable
- **THEN** the bundle marks the gap and does not substitute current text or claim success

#### Scenario: Stable export

- **WHEN** the same source snapshot is exported twice
- **THEN** canonical content and Markdown are identical

### Requirement: Portable parsing reports loss

JSON parse/serialize SHALL preserve supported schema provenance and unknown namespaced extension values. Unknown root fields SHALL be explicitly reported as unsupported; unsupported major versions SHALL fail with an actionable error. Markdown SHALL be a rendered view, not a round-trip authoring format.

#### Scenario: Extension round trip

- **WHEN** a supported bundle contains unknown namespaced extension JSON
- **THEN** serialization retains it without loss

#### Scenario: Unsupported version

- **WHEN** a bundle declares an unsupported major version
- **THEN** the viewer refuses interpretation rather than guessing

### Requirement: Local review is safe and self-contained

Export and review SHALL make no external writes or automatic remote artifact fetches. Default export SHALL omit raw logs, command strings, environment values, checkpoint bodies and machine-specific absolute paths, and record omissions. Rendering SHALL sanitize untrusted content and restrict link schemes. Local output SHALL refuse overwrite and publish only complete bundles. A reviewer SHALL trace a criterion through recorded evidence and delivery assurance without chat history.

#### Scenario: Offline reviewer

- **WHEN** a reviewer opens the local fixture bundle without network
- **THEN** criterion-to-result lineage and unavailable links remain understandable

#### Scenario: Unsafe content

- **WHEN** scope contains markup or unsafe links
- **THEN** the viewer renders safely without executing content or fetching artifacts

#### Scenario: Output failure

- **WHEN** the destination exists or writing fails
- **THEN** no existing output is overwritten and no partial bundle is presented as complete

### Requirement: Completion bundle reconstructs lifecycle chain
The portable evidence bundle SHALL include enough stable identity and provenance to reconstruct requirement, accepted spec revision, approved impact basis, implementation plan, apply operation, checkpoint lineage, task progress, evidence runs, review findings, diff identifiers, delivery state, completion identity and remaining uncertainty from a clean clone. Bundle export SHALL omit raw sensitive logs, environment values, unbounded checkpoint bodies and machine-specific absolute paths while recording omissions.

#### Scenario: Clean clone readback
- **WHEN** a completion bundle is exported and opened in a clean clone without chat history
- **THEN** the reviewer can trace each completed criterion through accepted scope, impact basis, evidence run, review and delivery/completion provenance

#### Scenario: Remaining uncertainty is preserved
- **WHEN** completion includes accepted exceptions, unavailable provider observations or non-blocking impact uncertainty
- **THEN** the bundle records those states instead of claiming complete certainty

#### Scenario: Partial bundle is not published
- **WHEN** bundle generation fails or required lifecycle links are missing
- **THEN** no partial bundle is presented as complete

> Not in this change: external artifact fetching or embedding raw command output.

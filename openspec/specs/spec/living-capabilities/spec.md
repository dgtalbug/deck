# spec/living-capabilities — attributable capability projection

## Purpose

Derive current capability statements from explicitly accepted source deltas with immutable completion lineage.

## Requirements

### Requirement: Projection requires attributable completion
Projection SHALL accept only explicit add/modify/remove deltas tied to exact accepted Deck-native requirement or criterion revisions and completion validated under the recorded delivery policy. Done lanes, task checkboxes, rendered Markdown, GitHub issue state or OpenSpec archive status alone SHALL not suffice. Every statement and removal SHALL retain source revision and evidence/delivery lineage. Missing proof or quarantined legacy identity SHALL prevent projection. Historical policy validity SHALL not be silently evaluated as if it used a later policy.

#### Scenario: Valid source
- **WHEN** a delta references exact eligible completed accepted scope and recorded policy/evidence
- **THEN** preview identifies its source-backed statement and assurance

#### Scenario: Unproven completion
- **WHEN** a legacy done story lacks attributable completion proof or accepted scope identity
- **THEN** export shows unknown and projection refuses that delta

#### Scenario: Reopened source
- **WHEN** source work changes or reopens before apply
- **THEN** the prior preview cannot introduce it as current truth

### Requirement: Conflicts require explicit preview acceptance

Projection SHALL preview the full ordered batch, conflicts and base/source digests before explicit acceptance. Incompatible deltas SHALL stop the whole batch. Apply SHALL reject stale previews atomically. Resolution SHALL record attribution and remain limited to source-backed text; semantic merging SHALL not occur.

#### Scenario: Ordered changes

- **WHEN** compatible add then modify then remove deltas are previewed
- **THEN** the resulting content and removal lineage follow the declared order

#### Scenario: Conflicting changes

- **WHEN** two deltas target incompatible versions of one statement
- **THEN** nothing applies until an explicit valid resolution is previewed and accepted

#### Scenario: Concurrent edit

- **WHEN** source or projection base changes after preview
- **THEN** apply refuses without partial writes

### Requirement: Projection retries and history are immutable
Accepted versions and delta identities SHALL be immutable. An identical retry SHALL return the prior result without duplication; changed content with a reused ID SHALL be refused. Rollback SHALL create an explicitly accepted new version referencing prior content, preserving all history. Legacy backfill SHALL use the same eligibility and preview rules and SHALL never rewrite source versions, accepted specification revisions or OpenSpec files.

#### Scenario: Retry
- **WHEN** an accepted batch is submitted again unchanged
- **THEN** no duplicate projection or statements are created

#### Scenario: Rollback
- **WHEN** a prior accepted version is selected and preview accepted
- **THEN** a new version records rollback while all historical versions remain unchanged

#### Scenario: Legacy backfill
- **WHEN** historical scope is considered for projection
- **THEN** only explicitly accepted eligible deltas become current; missing proof cannot be waived

> Not in this change: automatic semantic merging, provider authority, or rewriting OpenSpec archives as proof.

### Requirement: Capability projection requires Phase 4 completion proof
Living capability projection SHALL treat Phase 4 completion identity and current evidence/delivery provenance as the eligibility source for new or changed capability statements. A done lane, checked tasks, provider issue state, OpenSpec archive, rendered Markdown or legacy unbatched evidence SHALL NOT make a capability eligible without attributable completion proof.

#### Scenario: Completed source projects capability
- **WHEN** a source delta references accepted scope with current evidence runs, review, completion identity and delivery policy satisfied
- **THEN** projection can treat the delta as eligible with that lineage

#### Scenario: Legacy done work is unknown
- **WHEN** historical done work lacks Phase 4 completion proof
- **THEN** projection reports unknown or ineligible status rather than inferring current capability truth

> Not in this change: semantic merging or rewriting historical projection records.

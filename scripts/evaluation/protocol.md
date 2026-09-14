# Context evaluation protocol v1

This protocol is frozen before any trial. It evaluates the existing path/keyword
retrieval baseline against an opt-in graph-ranked candidate.

## Scenarios and labels

The held-out scenario taxonomy is: `resume`, `stale-checkpoint`, `refusal`,
`review`, and `relevant-source-change`. The relevance unit is a unique
`file:symbol` reference. Tuning fixtures and held-out labels are separate.

K is exactly 10. Results are ranked by descending deterministic score, then by
normalized reference using Unicode code-point ordering. Precision always uses a
denominator of 10, including empty results.

## Frozen promotion rule

Promotion requires at least five valid paired live runs per strategy, equal
budgets and matching model/permissions, zero candidate critical violations, no
increase in critical omissions, strictly higher candidate mean recall@10, and
candidate mean precision@10 and task-success rate no lower than baseline.
Interventions must not increase. These are pilot gates, not population-level
statistical claims.

Missing accounting, invalid manifests, cancellations, budget failures and
replays remain in reports. They cannot count toward the live sample size;
behavior and budget failures are not silently replaced.

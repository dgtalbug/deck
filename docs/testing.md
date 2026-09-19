# Test tiers

The suite is one `bun test` tree under `tests/` with stable directory boundaries. Package scripts turn those boundaries into named verification tiers so everyday edits get fast feedback while archive/pre-merge authority stays attached to the full gate.

## Command matrix

| Command | Tests | Wall time* | Use | Evidence |
|---|---|---|---|---|
| `bun run test:fast` | `tests/board`, `tests/cli`, `tests/core`, `tests/evaluation`, `tests/graph`, `tests/performance`, `tests/server`, `tests/ui`, `tests/ci-workflow.test.ts` | ~2m20s | confidence for most ordinary edits (everything except engine and smoke) | local only |
| `bun run test:ui` | `tests/ui` | ~23s | UI components, routing, SSE client | local only |
| `bun run test:board` | `tests/board`, `tests/core/board` | ~13s | board store, spec store, migrations | local only |
| `bun run test:core` | `tests/core` (includes `core/board`) | ~45s | core domain (events, git, projects, rules) | local only |
| `bun run test:server` | `tests/server` | ~14s | HTTP routes, SSE transport, MCP surface | local only |
| `bun run test:cli` | `tests/cli` | ~17s | CLI output contracts | local only |
| `bun run test:engine` | `tests/engine` | ~2m | verb engine, hooks, delivery, worktrees | local only |
| `bun run test:graph` | `tests/graph` | ~4s | code-graph indexing and lenses | local only |
| `bun run test:slow` | `tests/engine/non-blocking-hook-runner.test.ts`, `tests/engine/worktree-{execution,integration,recovery}.test.ts` | ~16s | the intentionally slow / integration subset on demand | local only |
| `bun run test:smoke` | `build:bin` + `tests/smoke` | build + ~1m | compiled-binary lifecycle (isolated temp home, fake `gh`) | local only |
| `bun run test:coverage` | full suite + coverage report | ~4–5m | the explicit coverage run | gate evidence |
| `bun run test:full` | full suite + coverage report | ~4–5m | archive / pre-merge gate | gate evidence |
| `bun run test` | alias of `test:full` | ~4–5m | unchanged default: full suite with coverage | gate evidence |

\* Wall times measured on one Apple Silicon machine; treat as relative, not absolute.

Only `test:full` (and its aliases `test`, `test:coverage`) satisfy archive or pre-merge verification. A passing fast or domain tier is local confidence, never gate evidence.

## Coverage boundary

Coverage used to be forced on by `bunfig.toml` (`[test] coverage = true`), taxing every local run. It is now explicit: the tier commands run plain `bun test`, and coverage is requested with `--coverage` on `test`, `test:coverage`, and `test:full`. The full gate therefore records the same coverage evidence as the previous always-on configuration — no evidence was removed, it just stopped being collected by commands that never needed it.

## Slow and timing-sensitive tests

Nothing here is skipped, hidden, or quarantined — these tests run in every full gate, and the notes exist so a slow or noisy result is classified instead of mysterious.

- **`tests/core/events/delivery.test.ts`** — *"an oversized event produces a deck.oversized diagnostic at its position, and no ack rows appear"* is the known **oversized SSE diagnostic full-suite flake**. The test holds a real SSE stream open and polls with 250ms read races against a 35s deadline. Under concurrent full-suite CPU load, frame delivery can be starved past the deadline and the assertion fails after a long hang (~35s). **Trigger:** many test files running concurrently. **Scope:** this one test (plus the UI-side sibling below). **Handling:** rerun the file in isolation (`bun test tests/core/events/delivery.test.ts`, ~0.6s green); only investigate as a real defect if it fails in isolation.
- **`tests/ui/sse.test.ts:148`** — *"oversized diagnostic frames"* is the client side of the same contract. It waits out a 140ms coalescing window (`Bun.sleep`), which can miss under load; same rerun-in-isolation guidance.
- **`tests/engine/non-blocking-hook-runner.test.ts`** — one test pins a real 10-second hook-kill timeout and therefore takes ~10s by design. Do not shrink the timeout to speed the suite up; the pin is the contract.
- **`tests/engine/worktree-{execution,integration,recovery}.test.ts`** — create real git worktrees and branches; integration-style, seconds each.
- **`tests/engine/` generally** — most engine tests spawn git subprocesses (~1–1.5s each, ~2m total). This is why engine is its own tier and is excluded from `test:fast`.
- **`tests/server/sse*.test.ts`, `tests/ui/sse.test.ts`** — listener/stream-based; keep an eye on abort and cleanup when touching them.

`tests/evaluation` and `tests/performance` sound slow but measure fast (~50ms, ~0.3s); they stay in `test:fast`.

## What this split did not do

The tier split added package scripts, one bunfig change, and this document. No test was deleted, skipped, renamed, or weakened, no assertion changed, and the full gate runs exactly the same tests with the same coverage evidence as before.

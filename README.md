# ♠ deck

**The control deck for your agent crew.**

deck is a local-first harness, SDD engine, and project brain for AI coding agents.
Spec-driven development as conventional-commit verbs, a kanban board on SQLite,
and a GitHub loop — one binary, one server, every agent.

> **less text, more work.** The UI is the eagle-eye view; agents do the typing.

---

## Status — what's real today

deck is early and building in the open. The **board, CLI, server, UI, the SDD engine verbs, and the git/gh layer are shipped and live-verified** (796 tests green). The plan and decision ledger live in [`.meta/sdd-engine.md`](.meta/sdd-engine.md).

**Working now:**

- **Board core** — `todo → groomed → active → verify → done` lanes on SQLite (WAL for concurrent agents, FTS5-ready), engine-owned lane law (humans move `todo ↔ groomed` only; `active`/`verify`/`done` are engine events), WIP limits, transactional event outbox.
- **Three doors, one core** — the same core functions behind a REST/SSE server ([OpenAPI 0.3.0](http://127.0.0.1:3325/openapi.json)), a CLI, and a single-file compiled binary.
- **CLI** — `deck note · board · groom · move · reorder · block · unblock · next · tweak · feat/fix/… · verify · review · archive · recall · checkpoint · ops · rules · graph · init · doctor · projects · serve`.
- **Web UI** — dark-default board at `http://127.0.0.1:3325` with live SSE updates, note capture in one action, card detail, groom form, deep-linkable `?view=todo|git`, guarded git view (branch/merge/commit/stash/PR), skeleton loading states.
- **Git + gh** — 13 guarded git operations plus PR create/list behind typed `GhUnavailable` handling; `gh` resolved beyond `PATH`.
- **Fast lane** — `deck tweak` promotes a one-line note straight to a build; ceremony scales with blast radius, never the other way around.
- **Resume-first `deck next`** — the most-advanced active card leads the digest (bounded ≤8k-char packet: scope, tasks, laws, checkpoint, recall); `deck next --ready` peeks at the queue read-only without starting or reserving anything; an empty board says so plainly.
- **Session checkpoints** — `deck checkpoint <id>` reads the card's durable decisions; `deck checkpoint <id> add "<text>" --kind decision|gotcha|remaining|blocker` writes one (revision-checked, retry-safe, human text never overwritten). New entries bind the accepted scope revision and spec bytes. Current-card checkpoints ride the `deck next` digest; stale ones are labeled historical, while legacy byte-only entries with unverified E03 scope are labeled provenance unknown.
- **Trustworthy recall** — session memory stays authoritative Markdown; the FTS index rebuilds transactionally from a content signature (mtime games can't fool it), queries are literal, and stale/error diagnostics surface in `deck recall` and the digest instead of pretending the memory is empty.
- **Tracked skill pack** — the fourteen `deck-*` runbooks are authored in `src/skills/`, embedded byte-for-byte into the binary, and `deck doctor` reports missing/stale/customized installs; `deck setup` repairs managed regions without touching your edits.
- **Versioned project intent (E03)** — epics carry optional intent + acceptance criteria with stable IDs (`deck epic-plan <id> intent/link/defer`), children acknowledge parent revisions, and the epic read shows uncovered criteria. Stories take dependency edges (`deck deps <story> add <prereq>`): ready selection skips blocked work and explains why, and a direct start re-checks every prerequisite inside the start reservation. Task/criterion identities survive re-grooms (no-op and reorder keep IDs; renames and removals are explicit ops), and accepted scope carries immutable revisions distinct from the publication checksum — checking a box never changes scope identity.

## Quick start

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/dgtalbug/deck.git
cd deck
bun install
bun run build          # UI bundle + single-file ./deck binary

./deck serve           # board at http://127.0.0.1:3325
./deck note "first thought"
./deck doctor          # 9 checks
```

Or run from source: `bun run dev` (server) · `bun test` (796 tests) · `bun run typecheck`.

## The loop (where this is going)

```
deck note ─→ groom ─→ deck feat ──→ implement ──→ verify ─⇄ gaps
              │          │                          │
              │          └─ issue published at      └─ clean → review gate
              │             implementation start         │
              └─ GroomProposal: verb · research ·       └─ archive: merge PR
                 spec deltas · tasks                      card → done · issue closed
```

- **Specs live in the db, not markdown folders** — every groomed change carries its delta spec, research, and tasks as first-class data.
- **Every spec gets a GitHub issue from birth** — grooming publishes a draft issue; starting the verb retargets it; labels mirror lanes; `deck sync` reconciles.
- **The verb is the process** — spec types (`deck types`) are user-editable workflows: `fix` demands Reproduce + Root cause and cannot pass review without a red→green test; `feat` demands design sections when the blast radius grows; custom types carry their own sections, task laws, and git conventions, edited live without touching code.
- **Agents get a full skill pack** — `deck setup` installs fourteen composable runbook skills (capture → build → finish, plus git conventions, resume, sync, graph lenses) into every detected agent host's skills directory — reproduced byte-for-byte from the tracked `src/skills/` source, with drift reported by `deck doctor`.
- **The engine is deterministic** — deck computes checklists and gaps instantly; agents bring the intelligence via `deck next` (≤8k-char bounded context packets with source/revision status and required-read directives on overflow).
- **No lock-in** — import/export adapters planned for openspec, spec-kit, backlog.md, and plain Markdown/JSON.

## Architecture

| Concern | Choice |
|---|---|
| Runtime | TypeScript on **Bun** (hard requirement) — `bun:sqlite`, `Bun.serve`, native TSX, `bun build --compile` |
| Store | **SQLite** via Drizzle — WAL, busy-timeout, embedded migrations |
| Server | `Bun.serve()` typed routes, SSE streams, content-negotiated static shell |
| UI | **Preact** components + signals, pragmatic-drag-and-drop, dark default with no-flash mode pin |
| Contract | zod schemas → OpenAPI 3.1 generated from the same source that validates requests |
| Distribution | single-file binary (`./deck`); npm publish planned |

```
src/
├── cli/        verb dispatch table (route↔core↔CLI parity)
├── core/       board domain, git ops, project registry — no I/O doors
├── server/     REST/SSE routes, static shell, OpenAPI
└── ui/         Preact board (slices: home, board, git)
```

## Design

deck wears the **Electric v2.0** design system (shared with its sibling [iris](https://www.npmjs.com/package/@dgtalbug/iris)) — oklch tokens, semantic color law, dark-first. The identity — spade mark, terminal banners, 72-column grid — is transcribed from locked brand artifact sets, never improvised.

## License

[MIT](LICENSE) © dgtalbug

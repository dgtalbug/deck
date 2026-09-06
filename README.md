# ♠ deck

**The control deck for your agent crew.**

deck is a local-first harness, SDD engine, and project brain for AI coding agents.
Spec-driven development as conventional-commit verbs, a kanban board on SQLite,
and a GitHub loop — one binary, one server, every agent.

> **less text, more work.** The UI is the eagle-eye view; agents do the typing.

---

## Status — what's real today

deck is early and building in the open. The **board, CLI, server, UI, and git/gh layer are shipped and live-verified** (310 tests green). The **SDD engine verbs are in active build** — the plan and decision ledger live in [`.meta/sdd-engine.md`](.meta/sdd-engine.md).

**Working now:**

- **Board core** — `todo → groomed → active → verify → done` lanes on SQLite (WAL for concurrent agents, FTS5-ready), engine-owned lane law (humans move `todo ↔ groomed` only; `active`/`verify`/`done` are engine events), WIP limits, transactional event outbox.
- **Three doors, one core** — the same core functions behind a REST/SSE server ([OpenAPI 0.3.0](http://127.0.0.1:3325/openapi.json)), a CLI, and a single-file compiled binary.
- **CLI** — `deck note · board · groom · move · reorder · block · unblock · next · tweak · verify · init · doctor · projects · serve`.
- **Web UI** — dark-default board at `http://127.0.0.1:3325` with live SSE updates, note capture in one action, card detail, groom form, deep-linkable `?view=todo|git`, guarded git view (branch/merge/commit/stash/PR), skeleton loading states.
- **Git + gh** — 13 guarded git operations plus PR create/list behind typed `GhUnavailable` handling; `gh` resolved beyond `PATH`.
- **Fast lane** — `deck tweak` promotes a one-line note straight to a build; ceremony scales with blast radius, never the other way around.

**Building next (the engine):** `deck feat`/`fix` end-to-end, specs stored in the deck database and **published as GitHub issues when implementation starts**, a deterministic verify-converge loop, a lean review gate, and archive → merge PR → changelog. Full plan: [`.meta/sdd-engine.md`](.meta/sdd-engine.md).

## Quick start

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/dgtalbug/deck.git
cd deck
bun install
bun run build          # UI bundle + single-file ./deck binary

./deck serve           # board at http://127.0.0.1:3325
./deck note "first thought"
./deck doctor          # 7/7 checks
```

Or run from source: `bun run dev` (server) · `bun test` (310 tests) · `bun run typecheck`.

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
- **Every spec gets a GitHub issue** — published automatically when implementation starts; labels mirror lanes; `deck sync` reconciles.
- **The engine is deterministic** — deck computes checklists and gaps instantly; agents bring the intelligence via `deck next` (≤2k-token context packs).
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

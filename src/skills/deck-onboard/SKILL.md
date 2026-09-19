---
name: deck-onboard
description: Onboard a project onto the deck engine — init, setup, doctor, and host adapters. Use when the user wants to start using deck in a repo, diagnose a broken setup, or list registered projects.
allowed-tools: Bash(deck:*)
owns: init, setup, doctor, projects, skill, backfill-specs, hooks, rules, help
hosts: shell-only contract — Claude Code, GitHub Copilot, and Codex run these recipes through the deck CLI in a shell; no host-native tool syntax is required or claimed
---

# deck-onboard — project lifecycle

**Compose:** → deck-explore (once onboarded)

## 0. Select

If the user names a project, pass `--project <name>` or `DECK_PROJECT=<name>` on every command. If they only say "set up deck" and the cwd is the repo — that is the project. If genuinely ambiguous, run `deck projects` and show it, then ask which.
 If ambiguous, you MUST prompt using the listing commands above — never guess.

## 1. Check state

```bash
deck projects   # registered projects (name, path, activity)
deck doctor     # drift report: registration, server, db, git, gh, AGENTS block, registry, issue map
```

Read doctor first: every `FAIL` line names its own fix. Do not improvise repairs — `deck init` is the only repair tool.

## 2. Act

### Fresh project
1. `deck init [--name <name>]` — registers the project, creates `.deck/board.sqlite`, writes the managed AGENTS.md block. Output carries the board URL (default `http://127.0.0.1:3325`).
2. `deck setup` — detects agent hosts (claude / agents / cursor / gemini / codex / copilot), installs the deck skill pack into each detected host's skillsDir, prints the adapter table. Missing host = no line; never create host dirs by hand.
3. Start a server if none: `deck serve` (host-side — the user or a supervisor runs it; do not background it yourself unless asked).

### Existing project
1. `deck doctor` all-pass → nothing to do; report and hand to deck-explore.
2. `FAIL registration` → `deck init`. `FAIL AGENTS.md block` stale → `deck init` refreshes it. `FAIL server` → tell the user to run `deck serve`.
3. `FAIL issue map` drift lines name their fix (usually `deck sync` — deck-sync owns that).

### Importing legacy openspec specs
- `deck backfill-specs` — one-time import of `openspec/specs/**` into spec cards + issues. Idempotent; run once per project.

### User-defined skills and hooks
- `deck skill new <name>` scaffolds `.agents/skills/<name>/SKILL.md` (deck never rewrites a lived-in skill).
- `deck graph` (owned by deck-impact) — code intelligence; `deck hooks` lists hooks from both sources: declared entries in `deck.rules.yaml` `hooks:` (pre can block a moment, post failures record on the card) and `.deck/hooks/<event>/` executables (onVerbStart, onVerifyResult, onArchive — post-only, never gating).

### Project law
- `deck rules` lists `deck.rules.yaml` principles (MUST vs machine check, severity); `deck rules check` runs the checks; `deck rules validate` dry-runs the file. No file = engine defaults.

## 3. Host-side commands (documented, not agent-owned)

- `deck serve [--port <n>] [--host <h>]` — the board server; non-loopback --host prints a loud warning (unauthenticated git writes).
- `deck mcp` — MCP stdio server (JSON-RPC, four tools); a host runs it, an agent connects.

## Laws (this phase)

- doctor never repairs — `deck init` does.
- AGENTS.md's managed block is the always-loaded law digest; the skill pack is the on-demand procedure. When they conflict, the block wins; report the conflict.
- Never create host directories or edit AGENTS.md by hand.

## Output

Report: project name, doctor pass/fail per check with fixes applied, hosts the skill pack installed into (or skipped counts), board URL. End with: "onboarded — deck-explore for the state tour."

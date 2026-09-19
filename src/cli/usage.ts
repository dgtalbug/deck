export const USAGE = `usage: deck <command> [args]

commands:
  note "<text>"                     capture a note into todo
  board [--view todo]               render the board (or the flat todo list)
  groom <id>                        print the GroomProposal contract for a note
  move <id> --to <lane>             move a card (manual lanes only)
  reorder <id> [--after <id2>]      move a card within its lane
  block <id> [reason] / unblock <id>
  next [--ready]                     resume-first next digest; --ready peeks the queue, read-only
                                      [--context-advisories baseline|graph] EXPERIMENTAL opt-in retrieval
                                      advisory (default off; failed its promotion pilot — not a shipped feature)
  baseline capture <card-id> <path>…  EXPERIMENTAL: snapshot selected sources (exact working-tree bytes, local only)
  baseline read <card-id>            EXPERIMENTAL: baseline records with exact digests and snapshot provenance
  baseline compare <card-id>         EXPERIMENTAL: working-tree comparison against the newest baseline
  baseline advise <card-id> [--query "<text>"] [--strategy baseline|graph]
                                      EXPERIMENTAL: bounded retrieval preview (not promoted; advisory only)
  checkpoint <card-id>               print the card's session checkpoint
  evidence export <epic-id> --out <directory> | evidence view <bundle.json>
                                    write local bundle.json + review.md evidence snapshot
  capability preview <delta-file> | capability apply <preview-id> --accept
                                    preview and explicitly accept local capability projection changes
  checkpoint <card-id> add "<text>" [--kind <k>] [--id <id>] [--expect-rev <n>] [--basis <sha>]
  tweak <id>                        promote a note to a tweak build
  verify <id> [--result clean|gaps]      compute gaps (or override the result)
  review <id>                       attack the diff vs spec — blocks archive
  task show|assign|patch            cooperative task edits (owner handle + revision-checked patch)
  handoff offer|accept|cancel|list  explicit task ownership transfer with basis validation
  workspace create|attach|status|reconcile|cancel
                                    opt-in isolated worktrees sharing one canonical board
  ops [list]                        unsettled operations (recovery ledger)
  ops reconcile <id> --confirm|--clean   release a crashed/legacy operation explicitly
  types [list] | types new <json-file> | types remove <id>
                                    spec-type registry (list · create-edit · remove)
  rules [list|check|validate]       project law (deck.rules.yaml) — check runs machine gates
  graph index|status|impact|why|lens|search
                                    code intelligence over .deck/graph.sqlite
  override <rule-id> --reason "<t>" record a user override on the active card
  init [--name <name>]              register + scaffold this project
  doctor                            report drift (all checks must pass)
  projects                          list registered projects
  sync                              flush the publish queue + report issue drift
  backfill-specs                   import existing specs + publish their issues
  feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert <id>
                                    start a build: active + issue + branch
  workflow <new-verb>               register a user verb on the shared engine
  hooks                             list hooks — deck.rules.yaml declarations + .deck/hooks executables
  recall <query>                    search session memory (FTS5)
  setup                             onboard agent hosts (adapter table + detection)
  skill new <name>                 scaffold a skill pack from the pinned template
  mcp                              MCP stdio server (JSON-RPC 2.0, four tools)
  epic "<title>" / epic <id>        create an epic, or print its story tree + criteria
  epic-plan <id> intent|link|defer|ack   epic intent/criteria authoring (revision-checked)
  deps <card> [list|add|remove|set <p>…] story dependency edges (cycle-checked)
  epics                            list epics with done/total rollup
  story <epicId> "<title>"          capture a story attached to an epic
  archive <id>                     prepare delivery: review + evidence + PR — card stays verify, delivery pending
  deliver <id>                     finalize: observe the merge/team policy (or local solo integration) — card → done
  delivery <id>                    delivery + cleanup status (pending vs delivered, retryable follow-ups)
  policy <id> --mode team|solo     enroll the delivery/evidence policy (--check, --approvals, --manual)
  cleanup <id>                     retry unfinished post-delivery follow-ups (issue close, branch, changelog, release)
  issue <id>                       print the card's mapped GitHub issue
  serve [--port <n>] [--host <h>]   start the server (default when bare)`;

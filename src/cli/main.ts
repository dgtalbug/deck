import { ZodError } from 'zod';
import { DeckError } from '../core/board/errors.ts';
import { tweak } from '../core/board/groom.ts';
import { moveLane } from '../core/board/lanes.ts';
import { applyExplicitResult } from '../core/board/verify.ts';
import { archiveCommand, cleanupCommand, deliverCommand, deliveryStatusCommand, policyCommand } from './delivery.ts';
import { renderHookWarnings } from '../core/engine/hooks.ts';
import { runVerification } from '../core/engine/verify.ts';
import { opsCommand } from './ops.ts';
import { nextCommand, checkpointCliCommand } from './next.ts';
import { depsCommand, epicPlanCommand } from './planning.ts';
import { revertCommand } from './revert.ts';
import { boardView, todoView } from '../core/board/views.ts';
import type { Lane } from '../core/board/types.ts';
import { initProject } from '../core/projects/init.ts';
import { ProjectRegistry } from '../core/projects/registry.ts';
import { projectSummary } from '../core/projects/summary.ts';
import { getStore } from '../core/projects/stores.ts';
import { renderDoctor, runDoctor } from '../core/projects/doctor.ts';
import { moveBody, reorderBody, verifyBody } from '../server/routes/cards.ts';
import { noteBody } from '../server/routes/notes.ts';
import { serveMain } from '../server/serve.ts';
import { flagString, flagStrings, parseArgs, UsageError, type ParsedArgs } from './args.ts';
import { startCommand } from './start.ts';
import { handoffCommand, taskCommand } from './collab.ts';
import { workspaceCommand } from './workspace.ts';
import { graphCommand } from './graph.ts';
import { overrideCommand, rulesCommand } from './rules.ts';
import {
  backfillCommand,
  epicCommand,
  epicsCommand,
  groomCommand,
  hooksCommand,
  issueCommand,
  recallCommand,
  setupCommand,
  storyCommand,
  skillCommand,
  reviewCommand,
  syncCommand,
  typesCommand,
  userVerbCommand,
  workflowCommand,
} from './ext.ts';
import { runMcpLoop, stdioIo } from '../server/mcp.ts';
import { ProjectResolutionError, resolveProject } from './context.ts';
import { detectLevel, palette, type Palette } from './color.ts';
import { withSpinner } from './spin.ts';
import { cardSummary, renderBoard, renderProjects, renderTodo } from './render.ts';
import { DECK_VERSION } from '../version.ts';

export const parity = {
  'deck note': 'addNote',
  'deck board': 'boardView',
  'deck groom': 'convertToVerbItem',
  'deck move': 'moveLane',
  'deck reorder': 'reorder',
  'deck block': 'setBlocked',
  'deck unblock': 'setBlocked',
  'deck next': 'nextDigest',
  'deck tweak': 'tweak',
  'deck verify': 'runVerification',
  'deck init': 'initProject',
  'deck doctor': 'runDoctor',
  'deck projects': 'projectSummary',
  'deck sync': 'syncProject',
  'deck backfill-specs': 'backfillSpecs',
  'deck feat': 'startVerb',
  'deck fix': 'startVerb',
  'deck docs': 'startVerb',
  'deck style': 'startVerb',
  'deck refactor': 'startVerb',
  'deck perf': 'startVerb',
  'deck test': 'startVerb',
  'deck build': 'startVerb',
  'deck ci': 'startVerb',
  'deck chore': 'startVerb',
  'deck revert': 'startVerb',
  'deck hooks': 'listHooks',
  'deck workflow': 'registerUserVerb',
  'deck recall': 'recall',
  'deck setup': 'initProject',
  'deck skill': 'scaffoldSkill',
  'deck mcp': 'runMcpLoop',
  'deck epic': 'addEpic',
  'deck epics': 'listEpics',
  'deck story': 'addNote',
  'deck archive': 'archiveVerb',
  'deck deliver': 'finalizeDelivery',
  'deck delivery': 'deliveryStatus',
  'deck policy': 'enrollPolicy',
  'deck cleanup': 'retryCleanup',
  'deck issue': 'viewIssue',
  'deck review': 'reviewGate',
  'deck types': 'listSpecTypes',
  'deck rules': 'loadRules',
  'deck graph': 'indexGraph',
  'deck override': 'recordOverride',
  'deck task': 'applyTaskPatch',
  'deck handoff': 'offerHandoff',
  'deck workspace': 'createWorkspace',
};

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export interface RunOptions {
  cwd?: string;
  registry?: ProjectRegistry;
  io?: CliIo;
}

const USAGE = `usage: deck <command> [args]

commands:
  note "<text>"                     capture a note into todo
  board [--view todo]               render the board (or the flat todo list)
  groom <id>                        print the GroomProposal contract for a note
  move <id> --to <lane>             move a card (manual lanes only)
  reorder <id> [--after <id2>]      move a card within its lane
  block <id> [reason] / unblock <id>
  next [--ready]                     resume-first next digest; --ready peeks the queue, read-only
  checkpoint <card-id>               print the card's session checkpoint
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

export type Command = (args: ParsedArgs, ctx: RunContext) => Promise<string | number>;

export interface RunContext {
  registry: ProjectRegistry;
  cwd: string;
  io: CliIo;
  pal: Palette;
}

const commands: Record<string, Command> = {
  note: async (args, ctx) => {
    const body = noteBody.parse({ title: args.positionals.join(' ') });
    const project = resolveProject(ctx.registry, args, ctx.cwd);
    const store = await getStore(project.path);
    return store.addNote(body.title).id;
  },
  board: async (args, ctx) => {
    const project = resolveProject(ctx.registry, args, ctx.cwd);
    return withSpinner(
      { isatty: Boolean(process.stdout.isTTY), dumb: Bun.env['TERM'] === 'dumb', io: ctx.io },
      'opening board…',
      async () => {
        const store = await getStore(project.path);
        return flagString(args.flags, 'view') === 'todo'
          ? renderTodo(todoView(store), ctx.pal)
          : renderBoard(boardView(store), ctx.pal);
      },
    );
  },
  groom: groomCommand,
  move: async (args, ctx) => {
    const id = requiredId(args, 'move <id> --to <lane>');
    const body = moveBody.parse({ to: flagString(args.flags, 'to') });
    const project = resolveProject(ctx.registry, args, ctx.cwd);
    const store = await getStore(project.path);
    return cardSummary(moveLane(store, id, body.to as Lane, 'human'));
  },
  reorder: async (args, ctx) => {
    const id = requiredId(args, 'reorder <id> [--after <id2>]');
    const body = reorderBody.parse({ afterId: flagString(args.flags, 'after') });
    const project = resolveProject(ctx.registry, args, ctx.cwd);
    const store = await getStore(project.path);
    return cardSummary(store.reorder(id, body.afterId));
  },
  block: async (args, ctx) => {
    const id = requiredId(args, 'block <id> [reason]');
    const reason = args.positionals.slice(1).join(' ');
    const project = resolveProject(ctx.registry, args, ctx.cwd);
    const store = await getStore(project.path);
    return cardSummary(store.setBlocked(id, reason.length > 0 ? reason : 'unspecified'));
  },
  unblock: async (args, ctx) => {
    const id = requiredId(args, 'unblock <id>');
    const project = resolveProject(ctx.registry, args, ctx.cwd);
    const store = await getStore(project.path);
    return cardSummary(store.setBlocked(id));
  },
  next: nextCommand,
  checkpoint: checkpointCliCommand,
  tweak: async (args, ctx) => {
    const id = requiredId(args, 'tweak <id>');
    const project = resolveProject(ctx.registry, args, ctx.cwd);
    const store = await getStore(project.path);
    return cardSummary(tweak(store, id));
  },
  verify: async (args, ctx) => {
    const id = requiredId(args, 'verify <id> [--result clean|gaps]');
    const project = resolveProject(ctx.registry, args, ctx.cwd);
    const store = await getStore(project.path);
    const explicit = flagString(args.flags, 'result');
    if (explicit === undefined) {
      const outcome = await runVerification(store, id);
      if (outcome.hookWarnings.length > 0) ctx.io.err(renderHookWarnings(outcome.hookWarnings).join('\n'));
      if (outcome.result === 'gaps') {
        const lines = outcome.gaps.map((gap) => `gap  ${gap.taskTitle} (evidence: ${gap.evidence})`);
        ctx.io.out(lines.join('\n'));
        return 1;
      }
      ctx.io.out(`clean — card ${id} holds in verify; deck review + deck archive close it`);
      return 0;
    }
    const card = applyExplicitResult(store, id, verifyBody.parse({ result: explicit }).result, flagStrings(args.flags, 'task'));
    if ('lane' in card && card.lane === 'verify') {
      return `${cardSummary(card)}\nclean — card ${id} holds in verify; deck review + deck archive close it`;
    }
    return cardSummary(card);
  },
  review: reviewCommand,
  task: taskCommand,
  handoff: handoffCommand,
  workspace: workspaceCommand,
  types: typesCommand,
  ops: opsCommand,
  init: async (args, ctx) => {
    const result = await initProject(ctx.registry, ctx.cwd, flagString(args.flags, 'name'));
    const p = ctx.pal;
    return [
      `${p.color('primary', '♠')} ${p.bold(`deck initialized — ${result.project.name}`)}`,
      '',
      `  ${p.dim('board')}  ${p.color('primary', `${result.boardUrl}/`)}`,
      `  ${p.dim('data')}   ${result.dbPath}`,
      `  ${p.dim('specs')}  specs/`,
      '',
      `  ${p.dim('next')}   deck note "your first thought"`,
    ].join('\n');
  },
  doctor: async (args, ctx) => {
    const checks = await runDoctor(ctx.registry, ctx.cwd);
    ctx.io.out(renderDoctor(checks));
    return checks.every((check) => check.pass) ? 0 : 1;
  },
  projects: async (_args, ctx) => {
    const projects = await Promise.all(
      ctx.registry.list().map(async (project) => projectSummary(await getStore(project.path), project)),
    );
    return renderProjects(projects, ctx.pal);
  },
  sync: syncCommand,
  'backfill-specs': backfillCommand,
  feat: (args, ctx) => startCommand(args, ctx, 'feat'),
  issue: issueCommand,
  fix: (args, ctx) => startCommand(args, ctx, 'fix'),
  docs: (args, ctx) => startCommand(args, ctx, 'docs'),
  style: (args, ctx) => startCommand(args, ctx, 'style'),
  refactor: (args, ctx) => startCommand(args, ctx, 'refactor'),
  perf: (args, ctx) => startCommand(args, ctx, 'perf'),
  test: (args, ctx) => startCommand(args, ctx, 'test'),
  build: (args, ctx) => startCommand(args, ctx, 'build'),
  ci: (args, ctx) => startCommand(args, ctx, 'ci'),
  chore: (args, ctx) => startCommand(args, ctx, 'chore'),
  revert: revertCommand,
  archive: archiveCommand,
  deliver: deliverCommand,
  delivery: deliveryStatusCommand,
  policy: policyCommand,
  cleanup: cleanupCommand,
  hooks: hooksCommand,
  rules: rulesCommand,
  graph: graphCommand,
  override: overrideCommand,
  epic: epicCommand,
  epics: epicsCommand,
  deps: depsCommand,
  'epic-plan': epicPlanCommand,
  story: storyCommand,
  setup: setupCommand,
  skill: skillCommand,
  mcp: async (args, ctx) => {
    await runMcpLoop(ctx.registry, stdioIo());
    return 0;
  },
  recall: recallCommand,
  workflow: workflowCommand,
  serve: async () => {
    await serveMain();
    return 0;
  },
};

function requiredId(args: ParsedArgs, usage: string): string {
  const id = args.positionals[0];
  if (id === undefined || id.length === 0) throw new UsageError(`usage: deck ${usage}`);
  return id;
}

export async function runCli(argv: string[], options: RunOptions = {}): Promise<number> {
  const io = options.io ?? { out: (t: string) => console.log(t), err: (t: string) => console.error(t) };
  const ctx: RunContext = {
    registry: options.registry ?? new ProjectRegistry(),
    cwd: options.cwd ?? process.cwd(),
    io,
    pal: palette(detectLevel(Bun.env, Boolean(process.stdout.isTTY))),
  };
  const args = parseArgs(argv.length === 1 && argv[0] === '-v' ? ['--version'] : argv);
  if (args.command === undefined) {
    if (args.flags['version'] !== undefined) {
      io.out(`deck v${DECK_VERSION}`);
      return 0;
    }
    await serveMain();
    return 0;
  }
  let handler: Command | undefined = commands[args.command];
  if (handler === undefined) {
    handler = await userVerbCommand(args, ctx);
    if (handler === undefined) {
      io.err(`deck: unknown command '${args.command}'\n\n${USAGE}`);
      return 64;
    }
  }
  try {
    const result = await handler(args, ctx);
    if (typeof result === 'number') return result;
    io.out(result);
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof ProjectResolutionError) {
      io.err(`deck: ${error.message}\n\n${USAGE}`);
      return 64;
    }
    if (error instanceof ZodError) {
      io.err(`deck: invalid arguments — ${error.issues.map((issue) => issue.message).join('; ')}`);
      return 1;
    }
    if (error instanceof DeckError) {
      io.err(`deck: ${error.message}`);
      return 1;
    }
    io.err(`deck: unexpected error — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return 2;
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}

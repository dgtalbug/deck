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
import { getReadStore, getStore } from '../core/projects/stores.ts';
import { renderDoctor, runDoctor } from '../core/projects/doctor.ts';
import { moveBody, reorderBody, verifyBody } from '../server/routes/cards.ts';
import { noteBody } from '../server/routes/notes.ts';
import { serveMain } from '../server/serve.ts';
import { flagString, flagStrings, parseArgs, UsageError, type ParsedArgs } from './args.ts';
import { startCommand } from './start.ts';
import { evidenceCommand } from './evidence.ts';
import { capabilityCommand } from './capability.ts';
import { baselineCommand } from './baseline.ts';
import { handoffCommand, taskCommand } from './collab.ts';
import { workspaceCommand } from './workspace.ts';
import { graphCommand } from './graph.ts';
import { overrideCommand, rulesCommand } from './rules.ts';
import { scopeCommand } from './scope.ts';
import { impactCommand } from './impact.ts';
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
import { USAGE } from './usage.ts';
import { detectLevel, palette, type Palette } from './color.ts';
import { withSpinner } from './spin.ts';
import { cardSummary, renderBoard, renderProjects, renderTodo } from './render.ts';
import { DECK_VERSION } from '../version.ts';
import { manifestByCliRoute, type AppOperation } from '../core/capabilities.ts';

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
  'deck baseline': 'captureSourceBaseline',
  'deck impact': 'captureImpactSnapshot',
  'deck evidence': 'collectEvidenceBundleSnapshot',
  'deck capability': 'previewCapabilityProjection',
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

export type Command = (args: ParsedArgs, ctx: RunContext) => Promise<string | number>;

export interface RunContext {
  registry: ProjectRegistry;
  cwd: string;
  io: CliIo;
  pal: Palette;
}

export const commands: Record<string, Command> = {
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
        const store = await getReadStore(project.path);
        return flagString(args.flags, 'view') === 'todo'
          ? renderTodo(todoView(store), ctx.pal)
          : renderBoard(boardView(store), ctx.pal);
      },
    );
  },
  groom: groomCommand,
  scope: scopeCommand,
  impact: impactCommand,
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
  baseline: baselineCommand,
  evidence: evidenceCommand,
  capability: capabilityCommand,
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
      ctx.registry.list().map(async (project) => projectSummary(await getReadStore(project.path), project)),
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
  start: async (args, ctx) => {
    const [verb, id] = args.positionals;
    if (verb === undefined || id === undefined) {
      throw new UsageError('usage: deck start <verb> <id> (e.g. deck start feat c1)');
    }
    const store = await (await import('../core/projects/stores.ts')).getStore(resolveProject(ctx.registry, args, ctx.cwd).path);
    if (!store.isRegisteredVerb(verb)) {
      throw new UsageError(`unknown verb '${verb}' — register it with deck workflow or use a built-in`);
    }
    const runner = await import('./start.ts');
    return runner.startCommand(
      { ...args, positionals: [id] },
      { registry: ctx.registry, cwd: ctx.cwd, io: ctx.io, pal: ctx.pal },
      verb as import('../core/board/types.ts').VerbName,
    );
  },
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

function commandHelp(op: AppOperation): string {
  const flags = op.cli?.flags === undefined ? '' : ` — flags: ${Object.keys(op.cli.flags).map((f) => `--${f}`).join(' ')}`;
  const deprecation = op.cli?.deprecated === true ? ' (deprecated alias — prefer deck start)' : '';
  return `${op.cli?.route ?? op.id}: ${op.summary}${flags}${deprecation}`;
}

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
  const byRoute = manifestByCliRoute();
  let args: ParsedArgs;
  try {
    args = parseArgs(
      argv.length === 1 && argv[0] === '-v' ? ['--version'] : argv,
      { specFor: (command) => byRoute.get(command)?.flags },
    );
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`deck: ${error.message}`);
      return 64;
    }
    throw error;
  }
  if (args.command === undefined || args.command === 'help') {
    if (args.flags['version'] !== undefined) {
      io.out(`deck v${DECK_VERSION}`);
      return 0;
    }
    // Bare invocation, `deck help` and `deck help <cmd>` are inert: help
    // only, never a project open, write, provider call, or port bind.
    if (args.positionals[0] !== undefined) {
      const target = byRoute.get(args.positionals[0]);
      io.out(target === undefined ? `deck: unknown command '${args.positionals[0]}'\n\n${USAGE}` : commandHelp(target.op));
      return target === undefined ? 64 : 0;
    }
    const flagNames = Object.keys(args.flags).filter((flag) => flag !== 'version');
    if (flagNames.length > 0) {
      io.err(`deck: flags without a command start nothing — use 'deck serve' to start the server`);
      return 64;
    }
    io.out(USAGE);
    return 0;
  }
  if (args.flags['version'] !== undefined) {
    io.out(`deck v${DECK_VERSION}`);
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
  const op = byRoute.get(args.command)?.op;
  if (op?.cli?.deprecated === true) {
    io.err(`deck: '${args.command}' is a deprecated alias — prefer 'deck start ${args.command} <id>'`);
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

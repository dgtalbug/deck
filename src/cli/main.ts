// The CLI door over the board core (design D1/D3): one dispatch table, one
// error path, one project-resolution rule. Every command is a core call plus
// rendering — route↔core↔CLI parity. Exit codes (D4): DeckError/ZodError → 1,
// usage/resolution → 64, unexpected → 2, doctor checks failed → 1.
import { ZodError } from 'zod';
import { DeckError } from '../core/board/errors.ts';
import { tweak } from '../core/board/groom.ts';
import { moveLane } from '../core/board/lanes.ts';
import { nextDigest } from '../core/board/next.ts';
import { applyVerifyResult } from '../core/board/verify.ts';
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
import { ProjectResolutionError, resolveProject } from './context.ts';
import { detectLevel, palette, type Palette } from './color.ts';
import { withSpinner } from './spin.ts';
import { cardSummary, renderBoard, renderProjects, renderTodo } from './render.ts';
import { DECK_VERSION } from '../version.ts';

// Command → core function (route↔core↔CLI parity; the parity test walks
// this table alongside the route tables).
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
  'deck verify': 'applyVerifyResult',
  'deck init': 'initProject',
  'deck doctor': 'runDoctor',
  'deck projects': 'projectSummary',
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
  next                              WIP-aware next digest for the engine
  tweak <id>                        promote a note to a tweak build
  verify <id> --result clean|gaps [--task "<title>"]...
  init [--name <name>]              register + scaffold this project
  doctor                            report drift (all checks must pass)
  projects                          list registered projects
  serve [--port <n>] [--host <h>]   start the server (default when bare)`;

type Command = (args: ParsedArgs, ctx: RunContext) => Promise<string | number>;

interface RunContext {
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
  groom: async (args, ctx) => {
    const id = requiredId(args, 'groom <id>');
    const project = resolveProject(ctx.registry, args, ctx.cwd);
    const store = await getStore(project.path);
    store.getNote(id); // 404 contract when the id is not a note
    const contract = {
      noteId: id,
      proposedVerb: 'feat',
      refinedTitle: '<one-line imperative title>',
      research: { codebaseFindings: ['<what you found in the code>'] },
      specDeltas: [{ op: 'ADDED', requirement: '<Requirement: name>', text: '<text>' }],
      tasks: ['<task>'],
      openQuestions: [],
    };
    return `POST /:project/cards/${id}/groom with:\n${JSON.stringify(contract, null, 2)}`;
  },
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
  next: async (args, ctx) => {
    const project = resolveProject(ctx.registry, args, ctx.cwd);
    const store = await getStore(project.path);
    return nextDigest(store).context;
  },
  tweak: async (args, ctx) => {
    const id = requiredId(args, 'tweak <id>');
    const project = resolveProject(ctx.registry, args, ctx.cwd);
    const store = await getStore(project.path);
    return cardSummary(tweak(store, id));
  },
  verify: async (args, ctx) => {
    const id = requiredId(args, 'verify <id> --result clean|gaps');
    const body = verifyBody.parse({ result: flagString(args.flags, 'result') });
    const project = resolveProject(ctx.registry, args, ctx.cwd);
    const store = await getStore(project.path);
    return cardSummary(
      applyVerifyResult(store, id, body.result, flagStrings(args.flags, 'task')),
    );
  },
  init: async (args, ctx) => {
    const result = await initProject(ctx.registry, ctx.cwd, flagString(args.flags, 'name'));
    const p = ctx.pal;
    // identity §3 init template: spade pip, board URL in lime, quiet rest
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
  // Bare `-v` is the short form of `--version`; everywhere else a short
  // single-dash token is a positional, so only this exact argv is remapped.
  const args = parseArgs(argv.length === 1 && argv[0] === '-v' ? ['--version'] : argv);
  if (args.command === undefined) {
    // Flag-only invocation: --version reports and exits; anything else serves,
    // exactly as before (spec: serve stays the default entry).
    if (args.flags['version'] !== undefined) {
      io.out(`deck v${DECK_VERSION}`);
      return 0;
    }
    await serveMain();
    return 0;
  }
  const handler = commands[args.command];
  if (handler === undefined) {
    io.err(`deck: unknown command '${args.command}'\n\n${USAGE}`);
    return 64;
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

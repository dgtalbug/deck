// `deck next` and the `deck checkpoint` CLI door (E02 board/cli + 7.3):
// thin dispatch wrappers — the selection law lives in core/board/next.ts,
// the checkpoint law in core/board/checkpoint.ts.
import { UsageError, type ParsedArgs } from './args.ts';
import { resolveProject } from './context.ts';
import { getStore } from '../core/projects/stores.ts';
import { nextDigest, readyWork } from '../core/board/next.ts';
import { checkpointCommand } from './checkpoint.ts';
import type { RunContext } from './main.ts';

export async function nextCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  // --ready is the explicit discovery door: read-only queue peek, never a
  // start or reservation (board/cli "Explicit ready-work discovery").
  const digest = args.flags['ready'] !== undefined ? readyWork(store) : nextDigest(store);
  return digest.context;
}

export async function checkpointCliCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  if (args.positionals[0] === undefined) throw new UsageError('usage: deck checkpoint <card-id> [add "<text>" …]');
  return checkpointCommand(store, args);
}

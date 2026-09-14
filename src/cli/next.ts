import { UsageError, type ParsedArgs } from './args.ts';
import { resolveProject } from './context.ts';
import { getStore } from '../core/projects/stores.ts';
import { nextDigest, readyWork } from '../core/board/next.ts';
import { checkpointCommand } from './checkpoint.ts';
import type { RunContext } from './main.ts';

export async function nextCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const digest = args.flags['ready'] !== undefined ? readyWork(store) : nextDigest(store);
  return digest.context;
}

export async function checkpointCliCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  if (args.positionals[0] === undefined) throw new UsageError('usage: deck checkpoint <card-id> [add "<text>" …]');
  return checkpointCommand(store, args);
}

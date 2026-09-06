// Extension-point commands (hooks-runner): `deck hooks` lists installed
// hooks; `deck workflow <new-verb>` registers a user verb on the shared
// engine. Both are one core call plus rendering.
import { UsageError } from './args.ts';
import { resolveProject } from './context.ts';
import { getStore } from '../core/projects/stores.ts';
import { listHooks } from '../core/engine/hooks.ts';
import { recall } from '../core/board/memory.ts';
import { backfillSpecs } from '../core/board/publish.ts';
import type { Command, RunContext } from './main.ts';
import { startCommand } from './start.ts';
import type { ParsedArgs } from './args.ts';

export async function hooksCommand(_args: ParsedArgs, ctx: RunContext): Promise<string> {
  const project = resolveProject(ctx.registry, _args, ctx.cwd);
  const store = await getStore(project.path);
  const listing = listHooks(store.projectPath);
  const lines: string[] = [];
  for (const hook of listing.hooks) lines.push(`hook   ${hook}`);
  for (const skipped of listing.skipped) lines.push(`skip   ${skipped} (not executable)`);
  if (lines.length === 0) {
    return 'no hooks — add executables at .deck/hooks/<event>/<name> (onVerbStart, onVerifyResult, onArchive)';
  }
  return lines.join('\n');
}

export async function workflowCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const name = args.positionals[0];
  if (name === undefined || name.length === 0) throw new UsageError('usage: deck workflow <new-verb>');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const registered = store.registerUserVerb(name);
  return [
    `${ctx.pal.color('primary', '♠')} verb '${registered}' registered on the shared engine`,
    '',
    `  start  deck ${registered} <id> — active + issue + branch`,
    `  hooks  deck hooks — the extension events`,
  ].join('\n');
}

// `deck backfill-specs` — the one-time openspec import, reported.
export async function backfillCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const report = await backfillSpecs(store);
  const lines = [
    `imported ${report.imported}  published ${report.published}  existing ${report.skippedExisting}`,
  ];
  for (const issue of report.issues) lines.push(`note  ${issue}`);
  return lines.join('\n');
}

// `deck recall <query>` — the pinned recall(query)→string[] contract at the
// terminal: one matched memory line per row.
export async function recallCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const query = args.positionals.join(' ');
  if (query.trim().length === 0) throw new UsageError('usage: deck recall <query>');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const hits = recall(store, query);
  if (hits.length === 0) return `no memory matches '${query.trim()}'`;
  return hits.join('\n');
}

// A registered user verb dispatches through the shared start command exactly
// as the built-ins do; unknown names return undefined (the usage error).
export async function userVerbCommand(args: ParsedArgs, ctx: RunContext): Promise<Command | undefined> {
  if (!/^[a-z][a-z0-9-]*$/.test(args.command ?? '')) return undefined;
  try {
    const project = resolveProject(ctx.registry, args, ctx.cwd);
    const store = await getStore(project.path);
    if (!store.isRegisteredVerb(args.command!)) return undefined;
    const verb = args.command!;
    return (verbArgs, verbCtx) => startCommand(verbArgs, verbCtx, verb);
  } catch {
    return undefined; // unresolvable project → the usage error is the answer
  }
}

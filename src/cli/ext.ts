// Extension-point commands (hooks-runner): `deck hooks` lists installed
// hooks; `deck workflow <new-verb>` registers a user verb on the shared
// engine. Both are one core call plus rendering.
import { UsageError } from './args.ts';
import { resolveProject } from './context.ts';
import { getStore } from '../core/projects/stores.ts';
import { listHooks } from '../core/engine/hooks.ts';
import { recall } from '../core/board/memory.ts';
import { backfillSpecs, syncProject } from '../core/board/publish.ts';
import { initProject } from '../core/projects/init.ts';
import { detectHosts, listAgentHosts, scaffoldSkill, SkillNameError } from '../core/projects/harness.ts';
import { DeckError } from '../core/board/errors.ts';
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

// `deck sync` — flush the publish queue, then report issue drift.
export async function syncCommand(args: ParsedArgs, ctx: RunContext): Promise<number> {
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const report = await syncProject(store);
  const lines: string[] = [];
  for (const flush of report.flushed) {
    lines.push(
      flush.queued
        ? `flush  ${flush.cardId} — still queued (gh offline)`
        : `flush  ${flush.cardId} — issue #${flush.issueNumber}`,
    );
  }
  if (report.flushedPending > 0) lines.push(`queue  ${report.flushedPending} publish(es) still pending`);
  if (report.gh === 'unavailable') lines.push('warn   gh unreachable — drift check skipped');
  for (const drift of report.drift) {
    lines.push(`drift  #${drift.issueNumber} [${drift.kind}] ${drift.detail}`);
    lines.push(`       fix: ${drift.fix}`);
  }
  if (report.labelsRefreshed > 0) lines.push(`labels ${report.labelsRefreshed} refreshed to match lanes`);
  if (lines.length === 0) {
    ctx.io.out('sync clean — queue empty, no drift');
    return 0;
  }
  ctx.io.out(lines.join('\n'));
  return report.drift.length > 0 ? 1 : 0;
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

// `deck setup` — deterministic host onboarding: idempotent register +
// scaffold, host detection, and the adapter table with per-host needs.
export async function setupCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const result = await initProject(ctx.registry, ctx.cwd, undefined);
  const store = await getStore(result.project.path);
  const hosts = listAgentHosts(store.raw());
  const detected = new Set(detectHosts(result.project.path, hosts).map((host) => host.id));
  const p = ctx.pal;
  const lines = [
    `${p.color('primary', '♠')} ${p.bold(`deck setup — ${result.project.name}`)}`,
    '',
    `  ${p.dim('board')}  ${result.boardUrl}/`,
    `  ${p.dim('data')}   ${result.dbPath}`,
    '',
    '  adapter table:',
  ];
  for (const host of hosts) {
    const mark = detected.has(host.id) ? p.color('primary', '●') : p.dim('○');
    lines.push(`  ${mark} ${host.id.padEnd(8)} ${host.displayName.padEnd(18)} skills: ${host.skillsDir}`);
  }
  lines.push('', '  detected:', ...(detected.size > 0 ? [...detected].sort().map((id) => `    ${id}`) : ['    none']));
  return lines.join('\n');
}

// `deck skill new <name>` — the pinned scaffold template.
export async function skillCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const [sub, name] = args.positionals;
  if (sub !== 'new' || name === undefined || name.length === 0) {
    throw new UsageError('usage: deck skill new <name>');
  }
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  try {
    const path = scaffoldSkill(project.path, name);
    return [
      `${ctx.pal.color('primary', '♠')} skill '${name}' scaffolded`,
      '',
      `  ${ctx.pal.dim('file')}  ${path}`,
      `  ${ctx.pal.dim('next')}  fill the description, then deck setup for host pickup`,
    ].join('\n');
  } catch (error) {
    if (error instanceof SkillNameError) throw new DeckError(error.message, { name });
    throw error;
  }
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

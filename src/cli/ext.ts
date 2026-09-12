// Extension-point commands (hooks-runner): `deck hooks` lists installed
// hooks; `deck workflow <new-verb>` registers a user verb on the shared
// engine. Both are one core call plus rendering.
import { UsageError } from './args.ts';
import { resolveProject } from './context.ts';
import { getStore } from '../core/projects/stores.ts';
import { listHooks } from '../core/engine/hooks.ts';
import { renderFindings, reviewGate } from '../core/engine/verify.ts';
import { getSpecType, listSpecTypes, removeSpecType, upsertSpecType } from '../core/board/types-registry.ts';
import { typeBody } from '../server/routes/types.ts';
import { recall } from '../core/board/memory.ts';
import { epicRollups } from '../core/board/views.ts';
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

// `deck groom <id>` — prints the GroomProposal contract for a note.
export async function groomCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const id = args.positionals[0];
  if (id === undefined || id.length === 0) throw new UsageError('usage: deck groom <id>');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  store.getNote(id); // 404 contract when the id is not a note
  const contract = {
    noteId: id,
    proposedVerb: 'feat',
    refinedTitle: '<one-line imperative title>',
    research: {
      story: '<what this is and why — the spec Story section; mermaid fences welcome>',
      codebaseFindings: ['<what you found in the code>'],
      blastRadius: ['<existing files/behaviors touched>'],
    },
    specDeltas: [{ op: 'ADDED', requirement: '<Requirement: name>', text: '<text>' }],
    tasks: ['<technical, code-level step>'],
    openQuestions: [],
  };
  return [
    `POST /:project/cards/${id}/groom with:`,
    JSON.stringify(contract, null, 2),
    '',
    'the spec renders story-first: Story (what & why) · Research (findings, RCA)',
    '· Requirements (deltas) · Blast radius · Git (auto: branch verb/first-four-',
    'words, commit prefix, --no-ff merge title, tag law) · Checklist (tasks).',
    'Story/research say WHAT we build; tasks are the only technical section.',
    'Minimal spec (title + tasks) stays valid — story, findings, deltas optional.',
  ].join('\n');
}

// `deck epic "<title>"` creates an epic; `deck epic <id>` prints its tree.
export async function epicCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const first = args.positionals[0];
  if (first === undefined || first.length === 0) throw new UsageError('usage: deck epic "<title>" | deck epic <id>');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const p = ctx.pal;
  if (/^[a-z0-9-]+-[a-z0-9]{4}$/.test(first)) {
    // looks like an id — print the tree
    const epic = store.getEpic(first);
    const stories = store.epicStories(first);
    const done = stories.filter((story) => 'lane' in story && story.lane === 'done').length;
    const lines = [
      `${p.color('primary', '♠')} ${p.bold(`epic — ${epic.title}`)}`,
      '',
      `  ${p.dim('id')}      ${epic.id}`,
      `  ${p.dim('rollup')} ${done}/${stories.length} stories done`,
      '',
    ];
    if (stories.length === 0) {
      lines.push('  (no stories — deck story <epicId> "<title>" adds one)');
    }
    for (const story of stories) {
      const lane = 'lane' in story ? story.lane : 'todo';
      const tasks = 'tasks' in story ? ` ${story.tasks.filter((task) => task.done).length}/${story.tasks.length}` : '';
      lines.push(`  ${story.id}  [${lane}]${tasks}  ${story.title}`);
    }
    return lines.join('\n');
  }
  const epic = store.addEpic(args.positionals.join(' '));
  return [
    `${p.color('primary', '♠')} epic created — ${epic.title}`,
    '',
    `  ${p.dim('id')}     ${epic.id}`,
    `  ${p.dim('story')}  deck story ${epic.id} "<title>"`,
  ].join('\n');
}

// `deck epics` — every epic with its rollup.
export async function epicsCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const rollups = epicRollups(store);
  if (rollups.length === 0) return 'no epics — deck epic "<title>" creates one';
  const p = ctx.pal;
  return rollups
    .map((epic) => `${p.dim(epic.id)}  ${epic.done}/${epic.stories} done  ${p.color('primary', epic.title)}`)
    .join('\n');
}

// `deck story <epicId> "<title>"` — a note born attached to its epic.
export async function storyCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const [epicId, ...title] = args.positionals;
  if (epicId === undefined || title.length === 0) throw new UsageError('usage: deck story <epicId> "<title>"');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const epic = store.getEpic(epicId); // typed 404 when not an epic
  const note = store.addNote(title.join(' '));
  store.setEpic(note.id, epic.id);
  return [note.id, `story attached to epic ${epic.id}`].join('\n');
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

// `deck review <id>` — the review gate, plus the advisory spec-type law
// surfaced for the reviewer (custom laws never hard-refuse; registry hard
// rules block inside reviewGate itself).
export async function reviewCommand(args: ParsedArgs, ctx: RunContext): Promise<string | number> {
  const id = args.positionals[0];
  if (id === undefined || id.length === 0) throw new UsageError('usage: deck review <id>');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const card = store.getVerbItem(id);
  const type = getSpecType(store, card.verb);
  if (type.taskLaw !== '') ctx.io.out(`type law (${card.verb}): ${type.taskLaw}`);
  const findings = await reviewGate(store, id);
  if (findings.length > 0) {
    ctx.io.out(renderFindings(findings));
    return 1;
  }
  return 'review clean — archive is unblocked';
}

// `deck types` — the spec-type registry at the terminal: list, create/edit
// from a JSON file (the groom file-payload convention), remove.
export async function typesCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const [sub, arg] = args.positionals;
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const p = ctx.pal;
  if (sub === undefined || sub === 'list') {
    const types = listSpecTypes(store);
    const lines = [`${p.color('primary', '♠')} spec types — ${types.length} registered`, ''];
    for (const type of types) {
      const sections = type.sections.length === 0
        ? 'no extra sections'
        : type.sections
            .map((section) =>
              section.alwaysRequired === true
                ? `${section.id}(required)`
                : section.requiredAboveRadius !== undefined
                  ? `${section.id}(≥${section.requiredAboveRadius} radius)`
                  : section.id,
            )
            .join(', ');
      const law = type.hardRule !== null ? ` hard rule: ${type.hardRule}` : '';
      lines.push(`  ${p.dim(type.id.padEnd(9))} ${sections}${law}`);
    }
    lines.push('', '  edit: deck types new <json-file> · remove: deck types remove <id>');
    return lines.join('\n');
  }
  if (sub === 'remove') {
    if (arg === undefined || arg.length === 0) throw new UsageError('usage: deck types remove <id>');
    removeSpecType(store, arg);
    return `spec type '${arg}' removed`;
  }
  if (sub === 'new') {
    if (arg === undefined || arg.length === 0) {
      throw new UsageError('usage: deck types new <json-file> (same shape as PUT /:project/types)');
    }
    const raw = await Bun.file(arg).text();
    const type = typeBody.parse(JSON.parse(raw));
    const saved = upsertSpecType(store, type);
    return [
      `${p.color('primary', '♠')} spec type '${saved.id}' saved`,
      '',
      `  ${p.dim('sections')} ${saved.sections.length}`,
      `  ${p.dim('law')}     ${saved.taskLaw === '' ? 'none' : saved.taskLaw}`,
      `  ${p.dim('hard')}    ${saved.hardRule ?? 'none'}`,
    ].join('\n');
  }
  throw new UsageError('usage: deck types [list] | deck types new <json-file> | deck types remove <id>');
}

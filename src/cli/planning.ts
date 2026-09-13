// E03 planning authoring doors (DECK-ARCH-015/016, review follow-up 6.1):
// `deck deps` for story dependency edges and the epic intent/criterion
// mutations. All writes go through the shared revision-checked store
// methods; stale expected revisions refuse without writing anything.
import { flagString, flagStrings, UsageError, type ParsedArgs } from './args.ts';
import { resolveProject } from './context.ts';
import { getStore } from '../core/projects/stores.ts';
import {
  acknowledgeParent,
  deferCriterion,
  epicPlanning,
  linkCriterion,
  listDependencies,
  setDependencies,
  setEpicIntent,
  unmetDependencies,
} from '../core/board/planning.ts';
import type { RunContext } from './main.ts';
import type { DocumentStore } from '../core/board/store.ts';
import { epicCriteriaLines } from '../core/board/planning.ts';

export async function depsCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const cardId = args.positionals[0];
  const sub = args.positionals[1];
  if (cardId === undefined) throw new UsageError('usage: deck deps <card-id> [list|add|remove <prereq-id>]');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  if (sub === undefined || sub === 'list') {
    const deps = listDependencies(store, cardId);
    if (deps.length === 0) return `card ${cardId} has no dependencies`;
    const lines = [`card ${cardId} depends on:`, ...deps.map((dep) => `  ${dep}`)];
    const blockers = unmetDependencies(store, cardId);
    if (blockers.length > 0) {
      lines.push('unmet:', ...blockers.map((blocker) => `  ${blocker.id} [${blocker.lane}] ${blocker.title}`));
    }
    return lines.join('\n');
  }
  if (sub === 'add' || sub === 'remove') {
    const prereq = args.positionals[2];
    if (prereq === undefined) throw new UsageError(`usage: deck deps ${cardId} ${sub} <prereq-id>`);
    const current = listDependencies(store, cardId);
    const next =
      sub === 'add'
        ? [...current, prereq]
        : current.filter((dep) => dep !== prereq);
    const expected = flagString(args.flags, 'expect-rev');
    setDependencies(store, 
      cardId,
      next,
      expected === undefined ? undefined : Number(expected),
    );
    return `deps of ${cardId}: ${next.length === 0 ? '(none)' : next.join(', ')}`;
  }
  // Full replacement: deck deps <card> set <a> <b> ...
  if (sub === 'set') {
    const deps = args.positionals.slice(2);
    const expected = flagString(args.flags, 'expect-rev');
    setDependencies(store, cardId, deps, expected === undefined ? undefined : Number(expected));
    return `deps of ${cardId}: ${deps.length === 0 ? '(none)' : deps.join(', ')}`;
  }
  throw new UsageError('usage: deck deps <card-id> [list|add|remove|set …]');
}

// `deck epic <id> intent "<text>" [--criterion "t" …] [--expect-rev N]`
// `deck epic <id> link <criterion-id> <child-id>`
// `deck epic <id> defer <criterion-id> --reason "<why>"`
// `deck epic <id> ack <child-id> [--expect-rev N]`
export async function epicPlanCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const epicId = args.positionals[0];
  const sub = args.positionals[1];
  if (epicId === undefined || sub === undefined) {
    throw new UsageError('usage: deck epic-plan <epic-id> intent|link|defer|ack …');
  }
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const expected = flagString(args.flags, 'expect-rev');
  const expectedRevision = expected === undefined ? undefined : Number(expected);
  if (sub === 'intent') {
    const intent = args.positionals.slice(2).join(' ');
    if (intent.trim().length === 0) throw new UsageError('usage: deck epic-plan <epic-id> intent "<text>"');
    const criteria = flagStrings(args.flags, 'criterion').map((title) => ({ title }));
    setEpicIntent(store, epicId, { intent, criteria, expectedRevision });
    const planning = epicPlanning(store, epicId);
    return `epic ${epicId} intent recorded — rev ${planning.revision}, ${planning.criteria.length} criteria`;
  }
  if (sub === 'link') {
    const criterionId = args.positionals[2];
    const childId = args.positionals[3];
    if (criterionId === undefined || childId === undefined) {
      throw new UsageError('usage: deck epic-plan <epic-id> link <criterion-id> <child-id>');
    }
    linkCriterion(store, epicId, criterionId, childId);
    return `criterion ${criterionId} covered by ${childId}`;
  }
  if (sub === 'defer') {
    const criterionId = args.positionals[2];
    const reason = flagString(args.flags, 'reason') ?? 'deferred';
    if (criterionId === undefined) throw new UsageError('usage: deck epic-plan <epic-id> defer <criterion-id> --reason "<why>"');
    deferCriterion(store, epicId, criterionId, reason);
    return `criterion ${criterionId} deferred — ${reason}`;
  }
  if (sub === 'ack') {
    const childId = args.positionals[2];
    if (childId === undefined) throw new UsageError('usage: deck epic-plan <epic-id> ack <child-id> [--expect-rev N]');
    acknowledgeParent(store, childId, expectedRevision);
    return `child ${childId} acknowledges epic ${epicId} at its current revision`;
  }
  throw new UsageError('usage: deck epic-plan <epic-id> intent|link|defer|ack …');
}

// The epic-read branch of `deck epic <id>`: story tree + criteria coverage +
// review-needed flags. Lives beside the planning reads so the rendering
// cannot drift from the data (and ext.ts stays under the line law).
export function renderEpicRead(
  store: DocumentStore,
  epicId: string,
  p: { color(a: string, b: string): string; bold(t: string): string; dim(t: string): string },
): string {
  const epic = store.getEpic(epicId);
  const stories = store.epicStories(epicId);
  const done = stories.filter((story) => 'lane' in story && story.lane === 'done').length;
  const planning = epicPlanning(store, epicId);
  const lines = [
    `${p.color('primary', '♠')} ${p.bold(`epic — ${epic.title}`)}`,
    '',
    `  ${p.dim('id')}      ${epic.id}`,
    `  ${p.dim('rollup')} ${done}/${stories.length} stories done`,
    `  ${p.dim('intent')}  ${planning.intent === undefined ? '(none — deck epic-plan <id> intent sets it)' : planning.intent.slice(0, 120)} (rev ${planning.revision})`,
    '',
  ];
  lines.push(...epicCriteriaLines(planning, p.dim));
  if (stories.length === 0) lines.push('  (no stories — deck story <epicId> "<title>" adds one)');
  for (const story of stories) {
    const lane = 'lane' in story ? story.lane : 'todo';
    const tasks = 'tasks' in story ? ` ${story.tasks.filter((task) => task.done).length}/${story.tasks.length}` : '';
    const flagged = planning.flaggedChildren.includes(story.id) ? '  [review-needed]' : '';
    lines.push(`  ${story.id}  [${lane}]${tasks}${flagged}  ${story.title}`);
  }
  return lines.join('\n');
}

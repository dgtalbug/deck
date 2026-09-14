import { z } from 'zod';
import { applyTaskPatch, assignTask, getTaskAssignment } from '../core/board/task-patches.ts';
import {
  acceptHandoff,
  cancelHandoff,
  listHandoffs,
  offerHandoff,
} from '../core/engine/handoffs.ts';
import { getStore } from '../core/projects/stores.ts';
import { resolveProject } from './context.ts';
import { flagString, UsageError, type ParsedArgs } from './args.ts';
import { taskAssignBody, taskPatchBody } from '../server/routes/cards.ts';
import { handoffAcceptBody, handoffCancelBody, handoffOfferBody } from '../server/routes/engine.ts';
import type { RunContext } from './main.ts';

function numFlag(args: ParsedArgs, name: string, usage: string): number {
  const raw = flagString(args.flags, name);
  const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) throw new UsageError(`usage: deck ${usage} (--${name} must be a positive integer)`);
  return value;
}

function boolFlag(args: ParsedArgs, name: string): boolean | undefined {
  const raw = flagString(args.flags, name);
  return raw === undefined ? undefined : raw === 'true' || raw === '1';
}

export async function taskCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const sub = args.positionals[0];
  const id = args.positionals[1];
  if (id === undefined) throw new UsageError('usage: deck task show|assign|patch <card-id> <task-id> …');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);

  if (sub === 'show') {
    return JSON.stringify(getTaskAssignment(store, id, args.positionals[2]!), null, 2);
  }

  if (sub === 'assign') {
    const taskId = args.positionals[2];
    const body = taskAssignBody.parse({
      owner: flagString(args.flags, 'owner'),
      by: flagString(args.flags, 'by') ?? 'human',
    });
    if (taskId === undefined) throw new UsageError('usage: deck task assign <card-id> <task-id> --owner <handle> [--by <who>]');
    const assignment = assignTask(store, { cardId: id, taskId, owner: body.owner, by: body.by });
    return `task ${taskId} assigned to ${body.owner} (revision ${assignment.revision})`;
  }

  if (sub === 'patch') {
    const taskId = args.positionals[2];
    const done = boolFlag(args, 'done');
    if (taskId === undefined || done === undefined) {
      throw new UsageError('usage: deck task patch <card-id> <task-id> --rev <n> --owner <handle> --command <id> --done true|false');
    }
    const body = taskPatchBody.parse({
      expectedRevision: numFlag(args, 'rev', 'task patch'),
      owner: flagString(args.flags, 'owner'),
      commandId: flagString(args.flags, 'command'),
      done,
    });
    const result = applyTaskPatch(store, {
      cardId: id,
      taskId,
      expectedRevision: body.expectedRevision,
      owner: body.owner,
      commandId: body.commandId,
      done: body.done,
    });
    return [
      `task ${taskId} ${result.duplicate ? 'replayed (duplicate command)' : 'patched'} — done=${result.done}, revision ${result.revision}`,
    ].join('\n');
  }

  throw new UsageError(`unknown task subcommand '${sub}' — show | assign | patch`);
}

export async function handoffCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const sub = args.positionals[0];
  const cardId = args.positionals[1];
  if (cardId === undefined) throw new UsageError('usage: deck handoff offer|accept|cancel|list <card-id> …');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);

  if (sub === 'list') {
    const rows = listHandoffs(store, { cardId });
    if (rows.length === 0) return `no handoffs on card ${cardId}`;
    return rows
      .map((row) => `${row.id} ${row.state} ${row.sender} → ${row.recipient} (task ${row.taskId}, scope rev ${row.scopeRevision})`)
      .join('\n');
  }

  if (sub === 'offer') {
    const body = handoffOfferBody.parse({
      taskId: flagString(args.flags, 'task'),
      sender: flagString(args.flags, 'from'),
      recipient: flagString(args.flags, 'to'),
      remainingWork: flagString(args.flags, 'remaining'),
      evidenceIds: flagString(args.flags, 'evidence')?.split(',').filter(Boolean),
    });
    const offer = offerHandoff(store, {
      cardId,
      taskId: body.taskId,
      sender: body.sender,
      recipient: body.recipient,
      remainingWork: body.remainingWork,
      evidenceIds: body.evidenceIds,
    });
    return `handoff ${offer.id} offered: ${offer.sender} → ${offer.recipient} (task ${body.taskId}, scope rev ${offer.scopeRevision})`;
  }

  const handoffId = args.positionals[2];
  if (handoffId === undefined) throw new UsageError('usage: deck handoff accept|cancel <card-id> <handoff-id> --as <handle>');

  if (sub === 'accept') {
    const body = handoffAcceptBody.parse({ recipient: flagString(args.flags, 'as') });
    const accepted = acceptHandoff(store, { handoffId, recipient: body.recipient });
    return `handoff ${accepted.id} accepted — task ${accepted.taskId} now belongs to ${body.recipient}`;
  }

  if (sub === 'cancel') {
    const body = handoffCancelBody.parse({ owner: flagString(args.flags, 'as') });
    const cancelled = cancelHandoff(store, { handoffId, owner: body.owner });
    return `handoff ${cancelled.id} cancelled — ${cancelled.sender} keeps task ${cancelled.taskId}`;
  }

  throw new UsageError(`unknown handoff subcommand '${sub}' — offer | accept | cancel | list`);
}

import { z } from 'zod';
import type { CardRow, TaskRow } from './schema.ts';
import type { Epic, Note, TaskState, Tweak, VerbItem } from './types.ts';

export const researchSchema = z.object({
  codebaseFindings: z.array(z.string()),
  rca: z.string().optional(),
  blastRadius: z.array(z.string()).optional(),
  story: z.string().optional(),
  sections: z.record(z.string(), z.string()).optional(),
});

export function toTaskState(row: TaskRow): TaskState {
  return {
    id: row.id,
    title: row.title,
    done: row.done,
    ...(row.addedByVerify === true ? { addedByVerify: true } : {}),
  };
}

export function toNote(row: CardRow): Note {
  return { id: row.id, title: row.title, createdAt: row.createdAt };
}

export function toEpic(row: CardRow): Epic {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    type: 'epic',
    ...(row.historyAt !== null ? { historyAt: row.historyAt } : {}),
  };
}

export function toTweak(row: CardRow): Tweak {
  return {
    id: row.id,
    title: row.title,
    ...(row.epicId !== null ? { epicId: row.epicId } : {}),
    requirement: row.requirement ?? row.title,
    lane: row.lane,
    position: row.position,
    ...(row.historyAt !== null ? { historyAt: row.historyAt } : {}),
    ...(row.completedAt !== null ? { completedAt: row.completedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toVerbItem(row: CardRow, taskRows: TaskRow[]): VerbItem {
  return {
    id: row.id,
    title: row.title,
    ...(row.epicId !== null ? { epicId: row.epicId } : {}),
    verb: row.verb ?? 'chore',
    lane: row.lane,
    position: row.position,
    specPath: row.specPath ?? '',
    tasks: taskRows.map(toTaskState),
    research: researchSchema.parse(JSON.parse(row.research ?? '{"codebaseFindings":[]}')),
    ...(row.blockedReason !== null && row.blockedAt !== null
      ? { blocked: { reason: row.blockedReason, at: row.blockedAt } }
      : {}),
    ...(row.historyAt !== null ? { historyAt: row.historyAt } : {}),
    ...(row.completedAt !== null ? { completedAt: row.completedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}


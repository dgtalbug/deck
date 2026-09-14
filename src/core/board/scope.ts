import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DeckError } from './errors.ts';
import { newTaskId } from './ids.ts';
import { cards, scopeItems, scopeRevisions } from './schema.ts';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';
import type { CriterionOp, TaskOp, TaskState } from './types.ts';

export const UNCLASSIFIED = 'unclassified';

interface ScopeSnapshot {
  verb: string;
  title: string;
  tasks: Array<{ id: string; title: string }>;
  criteria: Array<{ id: string; state: string; title: string }>;
}

export function scopeDigest(snapshot: ScopeSnapshot): string {
  const canonical = [
    `verb: ${snapshot.verb}`,
    `title: ${snapshot.title}`,
    ...snapshot.tasks.map((task, index) => `task ${index}: ${task.id} ${task.title}`),
    ...[...snapshot.criteria]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((criterion) => `criterion: ${criterion.id} ${criterion.state} ${criterion.title}`),
  ].join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

export function currentScopeRevision(db: SQLiteBunDatabase, cardId: string): number {
  const row = db.select({ revision: cards.scopeRevision }).from(cards).where(eq(cards.id, cardId)).get();
  return row?.revision ?? 0;
}

export function scopeCriteria(db: SQLiteBunDatabase, cardId: string): Array<{ id: string; title: string; state: string }> {
  return db
    .select({ id: scopeItems.id, title: scopeItems.title, state: scopeItems.state })
    .from(scopeItems)
    .where(eq(scopeItems.cardId, cardId))
    .all();
}

export function recordScopeRevision(
  db: SQLiteBunDatabase,
  cardId: string,
  snapshot: ScopeSnapshot,
  operations: string[],
): { revision: number; changed: boolean } {
  const digest = scopeDigest(snapshot);
  const current = currentScopeRevision(db, cardId);
  const newest = db.select().from(scopeRevisions).where(eq(scopeRevisions.cardId, cardId)).all().at(-1) ?? undefined;
  if (newest !== undefined && newest.digest === digest && current === newest.revision) {
    return { revision: current, changed: false };
  }
  const revision = current + 1;
  db.insert(scopeRevisions)
    .values({ cardId, revision, digest, operations: JSON.stringify(operations), createdAt: new Date().toISOString() })
    .run();
  db.update(cards).set({ scopeRevision: revision }).where(eq(cards.id, cardId)).run();
  return { revision, changed: true };
}

export function applyCriterionOps(
  db: SQLiteBunDatabase,
  cardId: string,
  revision: number,
  existing: Array<{ id: string; title: string; state: string }>,
  activeTitles: string[],
  ops: CriterionOp[] | undefined,
  reviewed: boolean,
): Array<{ id: string; state: string; title: string }> {
  const byTitle = new Map(existing.filter((item) => item.state === 'active').map((item) => [item.title, item]));

  for (const op of ops ?? []) {
    if (op.op !== 'remove' && op.op !== 'supersede') continue;
    const target = byTitle.get(op.title);
    if (target === undefined) {
      throw new DeckError(
        `criterion '${op.title}' is not an active criterion of ${cardId} — list current criteria before removing`,
        { cardId, title: op.title },
      );
    }
    const state = op.op === 'remove' ? 'removed' : 'superseded';
    db.update(scopeItems)
      .set({ state, lastRevision: revision })
      .where(and(eq(scopeItems.cardId, cardId), eq(scopeItems.id, target.id)))
      .run();
    byTitle.delete(op.title);
  }

  const result: Array<{ id: string; state: string; title: string }> = [];
  const seen = new Set<string>();
  for (const title of activeTitles) {
    if (seen.has(title)) continue; 
    seen.add(title);
    const existingItem = byTitle.get(title);
    if (existingItem !== undefined) {
      result.push({ id: existingItem.id, state: 'active', title });
      continue;
    }
    if (!reviewed) {
      result.push({ id: UNCLASSIFIED, state: 'active', title });
      continue;
    }
    const id = `c-${createHash('sha256').update(`${cardId}\n${title}`).digest('hex').slice(0, 8)}`;
    db.insert(scopeItems)
      .values({ cardId, id, kind: 'criterion', title, state: 'active', firstRevision: revision, lastRevision: revision })
      .onConflictDoNothing()
      .run();
    result.push({ id, state: 'active', title });
  }
  return result;
}

export function applyTaskOps(existing: TaskState[], titles: string[], taskOps: TaskOp[] | undefined): Array<{ id: string; title: string }> {
  if (taskOps === undefined) {
    const oldTitles = existing.map((task) => task.title);
    const sameSet =
      oldTitles.length === titles.length &&
      [...oldTitles].sort().join('\u0000') === [...titles].sort().join('\u0000');
    if (!sameSet) {
      throw new DeckError(
        'task titles changed in a title-only re-groom — identity cannot be guessed; ' +
          'resubmit with taskOps (keep/rename/add/remove by task id)',
        { existing: oldTitles, proposed: titles },
      );
    }
    return titles.map((title) => {
      const match = existing.find((task) => task.title === title)!;
      return { id: match.id, title };
    });
  }
  const byId = new Map(existing.map((task) => [task.id, task]));
  const result: Array<{ id: string; title: string }> = [];
  const removed = new Set<string>();
  for (const op of taskOps) {
    if (op.op === 'add') {
      result.push({ id: newTaskId(), title: op.title });
      continue;
    }
    const task = byId.get(op.id);
    if (task === undefined) {
      throw new DeckError(`task id '${op.id}' is not a task of this card — list current tasks first`, { id: op.id });
    }
    if (op.op === 'remove') {
      removed.add(task.id);
      continue;
    }
    result.push({ id: task.id, title: op.op === 'rename' ? op.title : task.title });
  }
  const kept = new Set(result.map((task) => task.id));
  for (const task of existing) {
    if (!kept.has(task.id) && !removed.has(task.id)) {
      throw new DeckError(
        `task '${task.title}' (${task.id}) is missing from taskOps — keep, rename, or remove it explicitly`,
        { id: task.id, title: task.title },
      );
    }
  }
  return result;
}

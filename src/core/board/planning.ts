import { eq } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';
import {
  cards,
  childAcknowledgements,
  epicCriteria,
  epicCriterionLinks,
  epicIntent,
  storyDeps,
} from './schema.ts';
import { DeckError, NotFoundError, StaleWriterError } from './errors.ts';
import type { Card } from './types.ts';
import { runTx, type DocumentStore, type Tx } from './store.ts';
import { emitEvent } from '../events/outbox.ts';

function nowIso(): string {
  return new Date().toISOString();
}

export function unmetDependencies(
  store: DocumentStore,
  cardId: string,
  exec: SQLiteBunDatabase | Tx = store.db,
): Array<{ id: string; lane: string; title: string }> {
  const rows = exec.select().from(storyDeps).where(eq(storyDeps.cardId, cardId)).all();
  const blockers: Array<{ id: string; lane: string; title: string }> = [];
  for (const row of rows) {
    const dep = exec.select().from(cards).where(eq(cards.id, row.dependsOn)).get();
    if (dep === undefined || dep.lane !== 'done') {
      blockers.push({ id: row.dependsOn, lane: dep?.lane ?? 'missing', title: dep?.title ?? 'missing' });
    }
  }
  return blockers;
}

export function setDependencies(store: DocumentStore, cardId: string, dependsOn: string[], expectedRevision?: number | undefined): Card {
  if (expectedRevision !== undefined) {
    const current = store.db.select({ v: cards.scopeRevision }).from(cards).where(eq(cards.id, cardId)).get();
    if ((current?.v ?? 0) !== expectedRevision) {
      throw new StaleWriterError(`dependencies of ${cardId}`, expectedRevision, current?.v ?? 0);
    }
  }
  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, cardId)).get();
    if (!row || row.type !== 'verb') throw new NotFoundError('verb item', cardId);
    const unique = [...new Set(dependsOn)];
    if (unique.includes(cardId)) {
      throw new DeckError(`card ${cardId} cannot depend on itself`, { cardId });
    }
    for (const dep of unique) {
      const depRow = tx.select().from(cards).where(eq(cards.id, dep)).get();
      if (depRow === undefined || depRow.type !== 'verb') {
        throw new DeckError(
          `prerequisite '${dep}' is not a story in this project — dependencies reference existing verb items`,
          { cardId, dependsOn: dep },
        );
      }
    }
    const edges = new Map<string, Set<string>>();
    for (const edge of tx.select().from(storyDeps).all()) {
      if (!edges.has(edge.cardId)) edges.set(edge.cardId, new Set());
      edges.get(edge.cardId)!.add(edge.dependsOn);
    }
    edges.set(cardId, new Set(unique));
    const visiting = new Set<string>();
    const visit = (node: string): boolean => {
      if (visiting.has(node)) return true;
      if (edges.get(node) === undefined) return false;
      visiting.add(node);
      for (const next of edges.get(node)!) if (visit(next)) return true;
      visiting.delete(node);
      return false;
    };
    if (visit(cardId)) {
      throw new DeckError(
        `dependency edit on ${cardId} would create a cycle — prerequisites must form a DAG`,
        { cardId, dependsOn: unique },
      );
    }
    tx.delete(storyDeps).where(eq(storyDeps.cardId, cardId)).run();
    for (const dep of unique) {
      tx.insert(storyDeps).values({ cardId, dependsOn: dep, createdAt: nowIso() }).run();
    }
    emitEvent(tx, 'card.deps.updated', { id: cardId, dependsOn: unique });
  });
  return store.getCard(cardId);
}

export function listDependencies(store: DocumentStore, cardId: string): string[] {
  return store.db.select().from(storyDeps).where(eq(storyDeps.cardId, cardId)).all().map((row) => row.dependsOn);
}

export function setEpicIntent(
  store: DocumentStore,
  epicId: string,
  input: { intent: string; criteria: Array<{ id?: string; title: string }>; expectedRevision?: number | undefined },
): void {
  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, epicId)).get();
    if (!row || row.type !== 'epic') throw new NotFoundError('epic', epicId);
    const current = tx.select().from(epicIntent).where(eq(epicIntent.epicId, epicId)).get();
    const revision = (current?.revision ?? 0) + 1;
    if (input.expectedRevision !== undefined && input.expectedRevision !== (current?.revision ?? 0)) {
      throw new StaleWriterError(`intent of epic ${epicId}`, input.expectedRevision, current?.revision ?? 0);
    }
    const existing = tx.select().from(epicCriteria).where(eq(epicCriteria.epicId, epicId)).all();
    const byId = new Map(existing.map((criterion) => [criterion.id, criterion]));
    const seen = new Set<string>();
    for (const [index, criterion] of input.criteria.entries()) {
      const id = criterion.id ?? byId.get(`pending-${index}`)?.id ?? `cr-${Math.random().toString(36).slice(2, 8)}`;
      if (seen.has(id)) throw new DeckError(`duplicate criterion id '${id}' in intent edit`, { epicId, id });
      seen.add(id);
      const prior = byId.get(id);
      tx.insert(epicCriteria)
        .values({
          epicId,
          id,
          title: criterion.title,
          state: 'active',
          deferral: null,
          firstRevision: prior?.firstRevision ?? revision,
        })
        .onConflictDoUpdate({
          target: [epicCriteria.epicId, epicCriteria.id],
          set: { title: criterion.title, state: 'active', deferral: null },
        })
        .run();
    }
    for (const criterion of existing) {
      if (!seen.has(criterion.id) && criterion.state === 'active') {
        tx.update(epicCriteria)
          .set({ state: 'removed' })
          .where(eq(epicCriteria.id, criterion.id))
          .run();
      }
    }
    tx.insert(epicIntent)
      .values({ epicId, revision, intent: input.intent, updatedAt: nowIso() })
      .onConflictDoUpdate({
        target: epicIntent.epicId,
        set: { revision, intent: input.intent, updatedAt: nowIso() },
      })
      .run();
    emitEvent(tx, 'epic.intent.updated', { id: epicId, revision });
  });
}

export function linkCriterion(store: DocumentStore, epicId: string, criterionId: string, childId: string): void {
  runTx(store.db, (tx) => {
    const epic = tx.select().from(cards).where(eq(cards.id, epicId)).get();
    if (!epic || epic.type !== 'epic') throw new NotFoundError('epic', epicId);
    const criterion = tx.select().from(epicCriteria).where(eq(epicCriteria.id, criterionId)).get();
    if (criterion === undefined || criterion.epicId !== epicId) {
      throw new NotFoundError('epic criterion', criterionId);
    }
    const child = tx.select().from(cards).where(eq(cards.id, childId)).get();
    if (child === undefined || child.type !== 'verb' || child.epicId !== epicId) {
      throw new DeckError(
        `card ${childId} is not a story of epic ${epicId} — criterion coverage links children of the same epic`,
        { epicId, childId },
      );
    }
    tx.insert(epicCriterionLinks)
      .values({ epicId, criterionId, childId, createdAt: nowIso() })
      .onConflictDoNothing()
      .run();
    emitEvent(tx, 'epic.criterion.linked', { id: epicId, criterionId, childId });
  });
}

export function deferCriterion(store: DocumentStore, epicId: string, criterionId: string, reason: string): void {
  runTx(store.db, (tx) => {
    const criterion = tx.select().from(epicCriteria).where(eq(epicCriteria.id, criterionId)).get();
    if (criterion === undefined || criterion.epicId !== epicId) {
      throw new NotFoundError('epic criterion', criterionId);
    }
    tx.update(epicCriteria).set({ state: 'deferred', deferral: reason }).where(eq(epicCriteria.id, criterionId)).run();
    emitEvent(tx, 'epic.criterion.deferred', { id: epicId, criterionId, reason });
  });
}

export function acknowledgeParent(store: DocumentStore, cardId: string, expectedRevision?: number | undefined): void {
  runTx(store.db, (tx) => {
    const child = tx.select().from(cards).where(eq(cards.id, cardId)).get();
    if (child === undefined || child.epicId === null) {
      throw new DeckError(`card ${cardId} is not attached to an epic — nothing to acknowledge`, { cardId });
    }
    const intent = tx.select().from(epicIntent).where(eq(epicIntent.epicId, child.epicId)).get();
    const current = intent?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== current) {
      throw new StaleWriterError(`intent of epic ${child.epicId}`, expectedRevision, current);
    }
    tx.insert(childAcknowledgements)
      .values({ cardId, epicId: child.epicId, revision: current, acknowledgedAt: nowIso() })
      .onConflictDoUpdate({
        target: childAcknowledgements.cardId,
        set: { revision: current, acknowledgedAt: nowIso() },
      })
      .run();
    emitEvent(tx, 'epic.parent.acknowledged', { id: cardId, revision: current });
  });
}

export function epicPlanning(store: DocumentStore, epicId: string): {
  intent: string | undefined;
  revision: number;
  criteria: Array<{ id: string; title: string; state: string; deferral: string | null; coveredBy: string[] }>;
  uncovered: string[];
  flaggedChildren: string[];
} {
  const intent = store.db.select().from(epicIntent).where(eq(epicIntent.epicId, epicId)).get();
  const revision = intent?.revision ?? 0;
  const criteria = store.db.select().from(epicCriteria).where(eq(epicCriteria.epicId, epicId)).all();
  const links = store.db.select().from(epicCriterionLinks).where(eq(epicCriterionLinks.epicId, epicId)).all();
  const covered = new Map<string, string[]>();
  for (const link of links) {
    const list = covered.get(link.criterionId) ?? [];
    list.push(link.childId);
    covered.set(link.criterionId, list);
  }
  const criteriaView = criteria.map((criterion) => ({
    id: criterion.id,
    title: criterion.title,
    state: criterion.state,
    deferral: criterion.deferral,
    coveredBy: covered.get(criterion.id) ?? [],
  }));
  const acks = store.db.select().from(childAcknowledgements).where(eq(childAcknowledgements.epicId, epicId)).all();
  const ackByChild = new Map(acks.map((ack) => [ack.cardId, ack.revision]));
  const children = store.epicStories(epicId).filter((story) => 'lane' in story);
  const flaggedChildren = children
    .map((story) => story.id)
    .filter((childId) => (ackByChild.get(childId) ?? 0) < revision);
  return {
    intent: intent?.intent,
    revision,
    criteria: criteriaView,
    uncovered: criteriaView
      .filter((criterion) => criterion.state === 'active' && criterion.coveredBy.length === 0)
      .map((criterion) => criterion.id),
    flaggedChildren,
  };
}

export function epicCriteriaLines(
  planning: ReturnType<typeof epicPlanning>,
  dim: (text: string) => string,
): string[] {
  if (planning.criteria.length === 0) return [];
  const lines = [`  ${dim('criteria')}`];
  for (const criterion of planning.criteria) {
    const flag =
      criterion.state !== 'active'
        ? ` [${criterion.state}${criterion.deferral ? `: ${criterion.deferral}` : ''}]`
        : criterion.coveredBy.length === 0
          ? ' [UNCOVERED]'
          : '';
    lines.push(`    ${criterion.id}  ${criterion.title}${flag} ← ${criterion.coveredBy.join(', ') || '—'}`);
  }
  lines.push('');
  return lines;
}

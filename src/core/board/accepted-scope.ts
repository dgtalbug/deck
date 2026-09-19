import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { DeckError, StaleWriterError } from './errors.ts';
import { newTaskId } from './ids.ts';
import { cards, scopeItems, scopeQuarantine, scopeRevisions, specCriteria, specPlanItems, specRequirements, specRevisions } from './schema.ts';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

export type ScopeItemState = 'active' | 'removed' | 'superseded';

export interface AcceptedRequirement {
  id: string;
  position: number;
  title: string;
  body: string;
}

export interface AcceptedCriterion {
  id: string;
  title: string;
  state: ScopeItemState;
}

export interface AcceptedPlanItem {
  id: string;
  position: number;
  title: string;
  state: ScopeItemState;
}

export interface AcceptedScopeSnapshot {
  verb: string;
  title: string;
  requirements: AcceptedRequirement[];
  criteria: AcceptedCriterion[];
  plan: AcceptedPlanItem[];
}

export type ScopeOperation =
  | { kind: 'adopt'; source: 'migration-audit' | 'groom-classify'; requirements: 'parsed' | 'unavailable' | 'none' }
  | { kind: 'story'; title?: string; verb?: string }
  | { kind: 'requirement'; op: 'add'; title: string; body: string }
  | { kind: 'requirement'; op: 'rename'; id: string; title: string }
  | { kind: 'requirement'; op: 'remove'; id: string }
  | { kind: 'requirement'; op: 'supersede'; id: string; replacement: string }
  | { kind: 'requirement'; op: 'keep'; id: string }
  | { kind: 'criterion'; op: 'add'; title: string }
  | { kind: 'criterion'; op: 'rename'; id: string; title: string }
  | { kind: 'criterion'; op: 'remove'; id: string }
  | { kind: 'criterion'; op: 'supersede'; id: string; replacement: string }
  | { kind: 'criterion'; op: 'keep'; id: string }
  | { kind: 'task'; op: 'add'; title: string }
  | { kind: 'task'; op: 'rename'; id: string; title: string }
  | { kind: 'task'; op: 'remove'; id: string }
  | { kind: 'task'; op: 'supersede'; id: string; replacement: string }
  | { kind: 'task'; op: 'reorder'; order: string[] }
  | { kind: 'task'; op: 'keep'; id: string };

export interface SpecificationRevision {
  cardId: string;
  revision: number;
  revisionId: string;
  contentDigest: string;
  operations: ScopeOperation[];
  actor: string;
  basisRevision: number | null;
  createdAt: string;
}

export interface RecordRevisionOutcome {
  revision: number;
  revisionId: string;
  contentDigest: string;
  changed: boolean;
}

export function revisionIdOf(cardId: string, revision: number): string {
  return `sr-${createHash('sha256').update(`${cardId}\n${revision}`).digest('hex').slice(0, 12)}`;
}

export function newRequirementId(): string {
  return `r-${Math.random().toString(36).slice(2, 10)}`;
}

export function newCriterionId(): string {
  return `c-${Math.random().toString(36).slice(2, 10)}`;
}

export function newPlanItemId(): string {
  return newTaskId();
}

// Deterministic requirement ids keyed by title, with an occurrence suffix when
// the same title appears twice in one snapshot — duplicate titles are legal
// only because the ids stay distinct.
export function deterministicRequirementIds(titles: string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((title) => {
    const occurrence = (seen.get(title) ?? 0) + 1;
    seen.set(title, occurrence);
    const hash = createHash('sha256').update(title).digest('hex').slice(0, 8);
    return occurrence === 1 ? `r-${hash}` : `r-${hash}-${occurrence}`;
  });
}

// Digest over accepted content only. Task progress, checkbox state, rendering
// and publication labels must never enter this canonical form.
export function acceptedContentDigest(snapshot: AcceptedScopeSnapshot): string {
  const canonical = [
    `verb: ${snapshot.verb}`,
    `title: ${snapshot.title}`,
    ...snapshot.requirements.map(
      (requirement) => `requirement: ${requirement.id} ${requirement.position} ${requirement.title}\n${requirement.body}`,
    ),
    ...[...snapshot.criteria]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((criterion) => `criterion: ${criterion.id} ${criterion.state} ${criterion.title}`),
    ...snapshot.plan.map((item) => `plan: ${item.id} ${item.position} ${item.state} ${item.title}`),
  ].join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// Pre-accepted-scope digest format, kept verbatim for the legacy revision rows
// the canonical writer mirrors.
export function legacyScopeDigest(snapshot: {
  verb: string;
  title: string;
  tasks: Array<{ id: string; title: string }>;
  criteria: Array<{ id: string; state: string; title: string }>;
}): string {
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

// Snapshot at the card's current accepted revision; null when the card has no
// accepted revisions (legacy unclassified) or unresolved quarantine excludes
// it from accepted-revision projection.
export function currentAcceptedSnapshot(db: SQLiteBunDatabase, cardId: string): AcceptedScopeSnapshot | null {
  const card = db.select().from(cards).where(eq(cards.id, cardId)).get();
  if (card === undefined || card.scopeRevision === null) return null;
  if (scopeClassification(db, cardId) !== 'accepted') return null;
  return snapshotAt(db, cardId, card.scopeRevision, card);
}

export function snapshotAt(
  db: SQLiteBunDatabase,
  cardId: string,
  revision: number,
  cardRow?: { verb: string | null; title: string },
): AcceptedScopeSnapshot | null {
  const revisionRow = db
    .select()
    .from(specRevisions)
    .where(and(eq(specRevisions.cardId, cardId), eq(specRevisions.revision, revision)))
    .get();
  if (revisionRow === undefined) return null;
  const card = cardRow ?? db.select().from(cards).where(eq(cards.id, cardId)).get();
  if (card === undefined) return null;
  const requirements = db
    .select()
    .from(specRequirements)
    .where(and(eq(specRequirements.cardId, cardId), eq(specRequirements.revision, revision)))
    .orderBy(asc(specRequirements.position))
    .all()
    .map((row) => ({ id: row.reqId, position: row.position, title: row.title, body: row.body }));
  const criteria = db
    .select()
    .from(specCriteria)
    .where(and(eq(specCriteria.cardId, cardId), eq(specCriteria.revision, revision)))
    .all()
    .map((row) => ({ id: row.criterionId, title: row.title, state: row.state }));
  const plan = db
    .select()
    .from(specPlanItems)
    .where(and(eq(specPlanItems.cardId, cardId), eq(specPlanItems.revision, revision)))
    .orderBy(asc(specPlanItems.position))
    .all()
    .map((row) => ({ id: row.taskId, position: row.position, title: row.title, state: row.state }));
  return { verb: card.verb ?? 'chore', title: card.title, requirements, criteria, plan };
}

export function acceptedRevision(
  db: SQLiteBunDatabase,
  cardId: string,
  revision?: number,
): SpecificationRevision | null {
  const row = revision === undefined
    ? db.select().from(specRevisions).where(eq(specRevisions.cardId, cardId)).orderBy(desc(specRevisions.revision)).get()
    : db
        .select()
        .from(specRevisions)
        .where(and(eq(specRevisions.cardId, cardId), eq(specRevisions.revision, revision)))
        .get();
  if (row === undefined) return null;
  return {
    cardId: row.cardId,
    revision: row.revision,
    revisionId: row.revisionId,
    contentDigest: row.contentDigest,
    operations: JSON.parse(row.operations) as ScopeOperation[],
    actor: row.actor,
    basisRevision: row.basisRevision,
    createdAt: row.createdAt,
  };
}

// Record one accepted revision. Identical accepted content at the current
// counter is a no-op that returns the existing revision identity.
export function recordAcceptedRevision(
  db: SQLiteBunDatabase,
  cardId: string,
  snapshot: AcceptedScopeSnapshot,
  operations: ScopeOperation[],
  input: { actor: string; basisRevision?: number | null },
): RecordRevisionOutcome {
  const digest = acceptedContentDigest(snapshot);
  const current = currentScopeRevision(db, cardId);
  if (current > 0) {
    const newest = db
      .select()
      .from(specRevisions)
      .where(and(eq(specRevisions.cardId, cardId), eq(specRevisions.revision, current)))
      .get();
    if (newest !== undefined && newest.contentDigest === digest) {
      return { revision: current, revisionId: newest.revisionId, contentDigest: digest, changed: false };
    }
  }
  const revision = current + 1;
  const revisionId = revisionIdOf(cardId, revision);
  const createdAt = new Date().toISOString();
  db.insert(specRevisions)
    .values({
      cardId,
      revision,
      revisionId,
      contentDigest: digest,
      operations: JSON.stringify(operations),
      actor: input.actor,
      basisRevision: input.basisRevision ?? (current > 0 ? current : null),
      createdAt,
    })
    .run();
  for (const requirement of snapshot.requirements) {
    db.insert(specRequirements)
      .values({
        cardId,
        revision,
        reqId: requirement.id,
        position: requirement.position,
        title: requirement.title,
        body: requirement.body,
      })
      .run();
  }
  for (const criterion of snapshot.criteria) {
    db.insert(specCriteria)
      .values({ cardId, revision, criterionId: criterion.id, title: criterion.title, state: criterion.state })
      .run();
  }
  for (const item of snapshot.plan) {
    db.insert(specPlanItems)
      .values({ cardId, revision, taskId: item.id, position: item.position, title: item.title, state: item.state })
      .run();
  }
  db.update(cards).set({ scopeRevision: revision }).where(eq(cards.id, cardId)).run();
  mirrorLegacyRows(db, cardId, revision, digest, operations, snapshot);
  return { revision, revisionId, contentDigest: digest, changed: true };
}

// Keep the pre-accepted-scope tables readable as a redundant projection of the
// canonical snapshot so historical readers (evidence bundles, planning) stay
// consistent without becoming identity sources. The mirrored row keeps the
// legacy digest format so the legacy no-op path still matches identical
// content during the transition.
function mirrorLegacyRows(
  db: SQLiteBunDatabase,
  cardId: string,
  revision: number,
  digest: string,
  operations: ScopeOperation[],
  snapshot: AcceptedScopeSnapshot,
): void {
  const legacyDigest = legacyScopeDigest({
    verb: snapshot.verb,
    title: snapshot.title,
    tasks: snapshot.plan.map((item) => ({ id: item.id, title: item.title })),
    criteria: snapshot.criteria.map((criterion) => ({ id: criterion.id, state: criterion.state, title: criterion.title })),
  });
  db.insert(scopeRevisions)
    .values({ cardId, revision, digest: legacyDigest, operations: JSON.stringify(operations), createdAt: new Date().toISOString() })
    .onConflictDoNothing()
    .run();
  for (const criterion of snapshot.criteria) {
    const existing = db
      .select()
      .from(scopeItems)
      .where(and(eq(scopeItems.cardId, cardId), eq(scopeItems.id, criterion.id)))
      .get();
    if (existing === undefined) {
      db.insert(scopeItems)
        .values({
          cardId,
          id: criterion.id,
          kind: 'criterion',
          title: criterion.title,
          state: criterion.state,
          firstRevision: revision,
          lastRevision: revision,
        })
        .onConflictDoNothing()
        .run();
    } else if (existing.title !== criterion.title || existing.state !== criterion.state) {
      db.update(scopeItems)
        .set({ title: criterion.title, state: criterion.state, lastRevision: revision })
        .where(and(eq(scopeItems.cardId, cardId), eq(scopeItems.id, criterion.id)))
        .run();
    }
  }
}

// Criteria for the card's current accepted revision; falls back to legacy
// scope_items for cards without accepted revisions so unclassified history
// stays readable.
export function scopeCriteria(
  db: SQLiteBunDatabase,
  cardId: string,
): Array<{ id: string; title: string; state: string }> {
  const snapshot = currentAcceptedSnapshot(db, cardId);
  if (snapshot !== null) {
    return snapshot.criteria.map((criterion) => ({ id: criterion.id, title: criterion.title, state: criterion.state }));
  }
  return db
    .select({ id: scopeItems.id, title: scopeItems.title, state: scopeItems.state })
    .from(scopeItems)
    .where(eq(scopeItems.cardId, cardId))
    .all();
}

export class UnknownScopeTargetError extends DeckError {
  constructor(cardId: string, kind: string, id: string) {
    super(
      `${kind} '${id}' is not part of the current accepted scope of ${cardId} — list the current scope before editing`,
      { cardId, kind, id },
    );
  }
}

export type ScopeClassification = 'accepted' | 'unclassified' | 'quarantined';

export interface RebasePreview {
  current: { cardId: string; revision: number; revisionId: string; contentDigest: string };
  attempted: ScopeOperation[];
  conflicts: string[];
  safeNoOps: ScopeOperation[];
}

// Stale basis refusals carry a structured rebase preview so the editor can
// rebase without a second read; it stays a StaleWriterError for existing
// callers that match on the typed race-condition error.
export class StaleBasisError extends StaleWriterError {
  readonly preview: RebasePreview;
  constructor(cardId: string, expected: number, actual: number, preview: RebasePreview) {
    super(`scope of ${cardId}`, expected, actual);
    this.preview = preview;
  }
}

export class ScopeConflictError extends DeckError {
  constructor(cardId: string, conflicts: string[]) {
    super(`scope edit conflicts with the current accepted scope of ${cardId}: ${conflicts.join('; ')}`, {
      cardId,
      conflicts,
    });
  }
}

export class UnclassifiedScopeError extends DeckError {
  constructor(cardId: string, classification: ScopeClassification) {
    super(
      `card ${cardId} has ${classification} scope identity — list and classify its current scope before applying id-based edits`,
      { cardId, classification },
    );
  }
}

function activeItem<T extends { id: string; state?: string }>(items: T[], id: string): T | undefined {
  return items.find((item) => item.id === id && (item.state === undefined || item.state === 'active'));
}

// Replay one operation against a snapshot, returning the next snapshot or a
// conflict string. Mutates nothing durable: the caller records one accepted
// revision from the final state, and removed ids stay attributable through the
// immutable prior-revision snapshots.
function applyOne(
  snapshot: AcceptedScopeSnapshot,
  operation: ScopeOperation,
  cardId: string,
): { conflict?: string; noOp?: boolean } {
  switch (operation.kind) {
    case 'adopt':
      return { conflict: 'adopt operations belong to migration adoption only' };
    case 'story': {
      let noOp = true;
      if (operation.title !== undefined && operation.title !== snapshot.title) {
        snapshot.title = operation.title;
        noOp = false;
      }
      if (operation.verb !== undefined && operation.verb !== snapshot.verb) {
        snapshot.verb = operation.verb;
        noOp = false;
      }
      return noOp ? { noOp: true } : {};
    }
    case 'requirement':
    case 'criterion':
    case 'task':
      break;
  }
  const kind = operation.kind;
  const isTask = kind === 'task';
  const isRequirement = kind === 'requirement';

  const findTarget = (): { id: string; title: string; state?: string } | undefined =>
    isTask
      ? activeItem(snapshot.plan, (operation as { id: string }).id)
      : isRequirement
        ? activeItem(snapshot.requirements, (operation as { id: string }).id)
        : activeItem(snapshot.criteria, (operation as { id: string }).id);

  const pushAdded = (title: string, body: string): void => {
    if (isTask) {
      snapshot.plan.push({ id: newPlanItemId(), position: snapshot.plan.length, title, state: 'active' });
    } else if (isRequirement) {
      const [id] = deterministicRequirementIds([...snapshot.requirements.map((item) => item.title), title]);
      snapshot.requirements.push({ id: id!, position: snapshot.requirements.length, title, body });
    } else {
      const id = `c-${createHash('sha256').update(`${cardId}\n${title}`).digest('hex').slice(0, 8)}`;
      const existing = snapshot.criteria.find((item) => item.id === id);
      if (existing !== undefined) {
        if (existing.state === 'active' && existing.title === title) return;
        existing.state = 'active';
        existing.title = title;
        return;
      }
      snapshot.criteria.push({ id, title, state: 'active' });
    }
  };

  const dropTarget = (id: string): void => {
    if (isTask) {
      snapshot.plan = snapshot.plan.filter((item) => item.id !== id);
    } else if (isRequirement) {
      snapshot.requirements = snapshot.requirements.filter((item) => item.id !== id);
    } else {
      snapshot.criteria = snapshot.criteria.filter((item) => item.id !== id);
    }
  };

  switch (operation.op) {
    case 'add': {
      const title = operation.title.trim();
      if (title === '') return { conflict: `${kind} add requires a non-empty title` };
      const before = isTask
        ? snapshot.plan.length
        : isRequirement
          ? snapshot.requirements.length
          : snapshot.criteria.filter((item) => item.state === 'active').length;
      pushAdded(title, 'body' in operation ? operation.body : '');
      const after = isTask
        ? snapshot.plan.length
        : isRequirement
          ? snapshot.requirements.length
          : snapshot.criteria.filter((item) => item.state === 'active').length;
      return before === after ? { noOp: true } : {};
    }
    case 'rename': {
      const target = findTarget();
      if (target === undefined) return { conflict: `${kind} '${operation.id}' is not in the current accepted scope` };
      if (target.title === operation.title) return { noOp: true };
      target.title = operation.title;
      return {};
    }
    case 'remove':
    case 'supersede': {
      const target = findTarget();
      if (target === undefined) return { conflict: `${kind} '${operation.id}' is not in the current accepted scope` };
      if (operation.op === 'supersede') {
        const replacement = operation.replacement.trim();
        if (replacement === '') return { conflict: `${kind} supersede requires a non-empty replacement title` };
        dropTarget(operation.id);
        pushAdded(replacement, '');
        return {};
      }
      dropTarget(operation.id);
      return {};
    }
    case 'reorder': {
      const active = snapshot.plan.filter((item) => item.state === 'active');
      const currentOrder = active.map((item) => item.id);
      const requested = [...operation.order];
      const sameSet =
        currentOrder.length === requested.length &&
        [...currentOrder].sort().join('\u0000') === [...requested].sort().join('\u0000');
      if (!sameSet) {
        return {
          conflict: `task reorder must be a permutation of the active plan (${currentOrder.join(', ')})`,
        };
      }
      if (currentOrder.join('\u0000') === requested.join('\u0000')) return { noOp: true };
      const byId = new Map(snapshot.plan.map((item) => [item.id, item]));
      let position = 0;
      for (const id of requested) {
        const item = byId.get(id);
        if (item !== undefined && item.state === 'active') {
          item.position = position;
          position += 1;
        }
      }
      snapshot.plan.sort((a, b) => a.position - b.position);
      return {};
    }
    case 'keep': {
      const target = findTarget();
      if (target === undefined) return { conflict: `${kind} '${operation.id}' is not in the current accepted scope` };
      return { noOp: true };
    }
  }
}

export interface ScopeEditInput {
  operations: ScopeOperation[];
  actor: string;
  basisRevision?: number | null;
}

// Compare-and-swap accepted scope editing: operations apply against the
// current accepted snapshot, either committing exactly one new accepted
// revision (or returning the existing one for identical content) or refusing
// with zero writes — stale basis yields a structured rebase preview, unknown
// targets yield typed conflicts.
export function applyScopeEdit(
  db: SQLiteBunDatabase,
  cardId: string,
  input: ScopeEditInput,
): RecordRevisionOutcome {
  const classification = scopeClassification(db, cardId);
  const current = currentScopeRevision(db, cardId);
  const snapshot = currentAcceptedSnapshot(db, cardId);
  if (classification !== 'accepted' || snapshot === null) {
    throw new UnclassifiedScopeError(cardId, classification);
  }
  if (input.basisRevision !== undefined && input.basisRevision !== null && input.basisRevision !== current) {
    const revisionRow = acceptedRevision(db, cardId)!;
    const conflicts: string[] = [];
    const safeNoOps: ScopeOperation[] = [];
    for (const operation of input.operations) {
      const probe = applyOne(structuredClone(snapshot), operation, cardId);
      if (probe.conflict !== undefined) conflicts.push(probe.conflict);
      else if (probe.noOp === true) safeNoOps.push(operation);
    }
    throw new StaleBasisError(cardId, input.basisRevision, current, {
      current: {
        cardId,
        revision: current,
        revisionId: revisionRow.revisionId,
        contentDigest: revisionRow.contentDigest,
      },
      attempted: input.operations,
      conflicts,
      safeNoOps,
    });
  }

  const working = structuredClone(snapshot);
  const conflicts: string[] = [];
  for (const operation of input.operations) {
    const outcome = applyOne(working, operation, cardId);
    if (outcome.conflict !== undefined) conflicts.push(outcome.conflict);
  }
  if (conflicts.length > 0) throw new ScopeConflictError(cardId, conflicts);

  // Requirement/task positions must stay dense over active items after edits.
  working.requirements = working.requirements.map((item, index) => ({ ...item, position: index }));
  const activePlan = working.plan.filter((item) => item.state === 'active');
  const inactivePlan = working.plan.filter((item) => item.state !== 'active');
  working.plan = [...activePlan.map((item, index) => ({ ...item, position: index })), ...inactivePlan];

  return recordAcceptedRevision(db, cardId, working, input.operations, {
    actor: input.actor,
    basisRevision: current,
  });
}

// How a card's scope identity stands: accepted revisions exist, no accepted
// record exists (legacy, readable, never inferred), or unresolved quarantine
// diagnostics exclude it from accepted-revision projection.
export function scopeClassification(db: SQLiteBunDatabase, cardId: string): ScopeClassification {
  const unresolved = db
    .select({ id: scopeQuarantine.id })
    .from(scopeQuarantine)
    .where(and(eq(scopeQuarantine.cardId, cardId), isNull(scopeQuarantine.resolvedAt)))
    .all();
  if (unresolved.length > 0) return 'quarantined';
  return acceptedRevision(db, cardId) === null ? 'unclassified' : 'accepted';
}

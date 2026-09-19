import type { Database } from 'bun:sqlite';

export type LegacyCardClass = 'safe' | 'unclassified' | 'quarantined';

export type QuarantineKind =
  | 'duplicate-task-id'
  | 'cross-card-task-id'
  | 'orphaned-task-state'
  | 'spec-without-scope';

export interface AuditDiagnostic {
  kind: QuarantineKind;
  cardId: string | null;
  detail: Record<string, unknown>;
}

export interface CardAudit {
  cardId: string;
  cardClass: LegacyCardClass;
  reasons: string[];
  diagnostics: AuditDiagnostic[];
}

export interface ScopeAuditReport {
  cards: CardAudit[];
  diagnostics: AuditDiagnostic[];
}

interface TaskRowLite {
  card_id: string;
  idx: number;
  id: string;
  title: string;
}

interface StateRowLite {
  task_id: string;
  card_id: string;
}

interface ItemRowLite {
  card_id: string;
  id: string;
  state: string;
}

interface CardRowLite {
  id: string;
  type: string;
  lane: string;
  research: string | null;
  completed_at: string | null;
}

// Read-only classification of legacy scope/task rows into safe (unambiguous,
// adoptable), unclassified (readable but acceptance must not be inferred) and
// quarantined (ambiguous identity, excluded from accepted-revision projection).
// The migration runs this before any schema conversion and records the
// diagnostics it returns; nothing here writes.
export function auditLegacyScope(db: Database): ScopeAuditReport {
  const diagnostics: AuditDiagnostic[] = [];

  const cards = db
    .query('SELECT id, type, lane, research, completed_at FROM cards')
    .all() as CardRowLite[];
  const tasks = db
    .query('SELECT card_id, idx, id, title FROM tasks')
    .all() as TaskRowLite[];
  const state = db
    .query('SELECT task_id, card_id FROM task_state')
    .all() as StateRowLite[];
  const items = db
    .query('SELECT card_id, id, state FROM scope_items')
    .all() as ItemRowLite[];
  const specCards = new Set(
    (db.query('SELECT DISTINCT card_id FROM specs').all() as Array<{ card_id: string }>).map((row) => row.card_id),
  );

  const tasksByCard = new Map<string, TaskRowLite[]>();
  for (const task of tasks) {
    const list = tasksByCard.get(task.card_id) ?? [];
    list.push(task);
    tasksByCard.set(task.card_id, list);
  }
  const ownerOfTask = new Map<string, string[]>();
  for (const task of tasks) {
    const owners = ownerOfTask.get(task.id) ?? [];
    owners.push(task.card_id);
    ownerOfTask.set(task.id, owners);
  }
  const tasksByCardAndId = new Map<string, Set<string>>();
  for (const task of tasks) {
    const set = tasksByCardAndId.get(task.card_id) ?? new Set<string>();
    set.add(task.id);
    tasksByCardAndId.set(task.card_id, set);
  }
  const stateByTask = new Map<string, StateRowLite>();
  for (const row of state) stateByTask.set(row.task_id, row);

  const audits: CardAudit[] = [];
  for (const card of cards) {
    if (card.type !== 'verb' && card.type !== 'tweak') continue;
    const cardTasks = tasksByCard.get(card.id) ?? [];
    const cardDiagnostics: AuditDiagnostic[] = [];
    const reasons: string[] = [];

    const idCounts = new Map<string, number>();
    for (const task of cardTasks) idCounts.set(task.id, (idCounts.get(task.id) ?? 0) + 1);
    for (const [id, count] of idCounts) {
      if (count > 1) {
        cardDiagnostics.push({
          kind: 'duplicate-task-id',
          cardId: card.id,
          detail: { taskId: id, occurrences: count },
        });
      }
    }

    for (const task of cardTasks) {
      const owners = ownerOfTask.get(task.id) ?? [];
      if (owners.length > 1) {
        cardDiagnostics.push({
          kind: 'cross-card-task-id',
          cardId: card.id,
          detail: { taskId: task.id, cards: owners },
        });
      }
      const stateRow = stateByTask.get(task.id);
      if (stateRow !== undefined && stateRow.card_id !== card.id) {
        cardDiagnostics.push({
          kind: 'orphaned-task-state',
          cardId: card.id,
          detail: { taskId: task.id, stateCardId: stateRow.card_id },
        });
      }
    }

    const itemIds = new Set(items.filter((item) => item.card_id === card.id).map((item) => item.id));

    const ownedIds = tasksByCardAndId.get(card.id) ?? new Set<string>();
    for (const row of state) {
      if (row.card_id !== card.id) continue;
      if (!ownedIds.has(row.task_id)) {
        cardDiagnostics.push({
          kind: 'orphaned-task-state',
          cardId: card.id,
          detail: { taskId: row.task_id, note: 'state row references a task this card does not own' },
        });
      }
    }

    if (specCards.has(card.id) && cardTasks.length === 0 && itemIds.size === 0 && !hasSpecDeltas(card.research)) {
      cardDiagnostics.push({
        kind: 'spec-without-scope',
        cardId: card.id,
        detail: { note: 'rendered spec versions exist but no reconstructable accepted scope' },
      });
    }

    diagnostics.push(...cardDiagnostics);

    if (cardDiagnostics.length > 0) {
      reasons.push(...cardDiagnostics.map((diagnostic) => diagnostic.kind));
      audits.push({ cardId: card.id, cardClass: 'quarantined', reasons, diagnostics: cardDiagnostics });
      continue;
    }
    if (card.lane === 'done' || card.completed_at !== null) {
      audits.push({
        cardId: card.id,
        cardClass: 'unclassified',
        reasons: ['historical completion without accepted-revision records'],
        diagnostics: [],
      });
      continue;
    }
    audits.push({ cardId: card.id, cardClass: 'safe', reasons: [], diagnostics: [] });
  }

  return { cards: audits, diagnostics };
}

function hasSpecDeltas(research: string | null): boolean {
  if (research === null) return false;
  try {
    const parsed = JSON.parse(research) as { codebaseFindings?: unknown; story?: unknown };
    return (
      (Array.isArray(parsed.codebaseFindings) && parsed.codebaseFindings.length > 0) ||
      (typeof parsed.story === 'string' && parsed.story.trim() !== '')
    );
  } catch {
    return false;
  }
}

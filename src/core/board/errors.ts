import type { Lane } from './types.ts';

export class DeckError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class LaneViolation extends DeckError {
  constructor(
    cardId: string,
    from: Lane,
    to: Lane,
    source: 'human' | 'engine',
  ) {
    super(
      `card ${cardId}: ${from} → ${to} is not allowed for ${source} — ` +
        `only engine events move cards into active/verify/done`,
      { cardId, from, to, source },
    );
  }
}

export class EngineOwnedError extends DeckError {
  constructor(cardId: string, lane: Lane, action: string) {
    super(
      `card ${cardId}: ${action} is not allowed in ${lane} — ` +
        `active/verify/done are engine-owned; use the engine doors instead`,
      { cardId, lane, action },
    );
  }
}

export class HoldViolation extends DeckError {
  constructor(cardId: string, lane: Lane) {
    super(
      `card ${cardId}: hold is not allowed in ${lane} — ` +
        `hold means pick-later and only applies to todo/groomed; ` +
        `active and verify do not pause (finish or verify-gaps them), ` +
        `done has no hold (deck revert <id> is the way back)`,
      { cardId, lane },
    );
  }
}

export class WipLimitError extends DeckError {
  constructor(active: number, limit: number, topCardId: string) {
    super(
      `WIP limit reached: ${active}/${limit} cards active — ` +
        `finish card ${topCardId} before starting a new build`,
      { active, limit, topCardId },
    );
  }
}

export class NotFoundError extends DeckError {
  constructor(entity: string, id: string) {
    super(`${entity} '${id}' not found`, { entity, id });
  }
}

export class DependencyBlockedError extends DeckError {
  constructor(cardId: string, blockers: Array<{ id: string; lane: string; title: string }>) {
    const names = blockers.map((blocker) => `${blocker.id} (${blocker.lane})`).join(', ');
    super(
      `card ${cardId} depends on unfinished prerequisite(s): ${names} — ` +
        `prerequisites must reach done before this story starts`,
      { cardId, blockers },
    );
  }
}

export class StaleWriterError extends DeckError {
  constructor(subject: string, expected: number, current: number) {
    super(
      `${subject} changed since you read it — expected revision ${expected}, current is ${current}; ` +
        `re-read and resubmit against the current revision`,
      { subject, expected, current },
    );
  }
}

export class UninitializedProjectError extends DeckError {
  constructor(projectPath: string) {
    super(
      `no board database at ${projectPath}/.deck/board.sqlite — initialize the project first ` +
        `(\`deck init\` or any write command such as \`deck note\`)`,
      { projectPath },
    );
  }
}

export class ReadOnlyStoreError extends DeckError {
  constructor(action: string) {
    super(
      `this store was opened read-only — '${action}' requires an application open ` +
        `(a write command or \`deck serve\`)`,
      { action },
    );
  }
}

export class LeaseStillActiveError extends DeckError {
  constructor(operationId: string, expiresAt: string, waitMs: number) {
    super(
      `operation ${operationId} holds a live lease until ${expiresAt} (~${Math.ceil(waitMs / 1000)}s) — ` +
        `explicit recovery is refused while the owner may still be alive`,
      { operationId, expiresAt, waitMs },
    );
  }
}

export class UncertainEffectsError extends DeckError {
  constructor(operationId: string, effects: Array<{ kind: string; state: string; id: string }>) {
    const names = effects.map((effect) => `${effect.id} (${effect.kind}, ${effect.state})`).join(', ');
    super(
      `operation ${operationId} still has active or uncertain external effects: ${names} — ` +
        `reconcile them before takeover`,
      { operationId, effects },
    );
  }
}

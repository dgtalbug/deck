// Typed exceptions per .meta/project-rules.md rule 5 — every message answers
// what, which id, why, what next. Never throw bare Error.
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

// Same-lane write refusal (v0.2.0 CRUD): edit/delete target a card that
// lives in an engine-owned lane. Distinct from LaneViolation (transitions).
export class EngineOwnedError extends DeckError {
  constructor(cardId: string, lane: Lane, action: string) {
    super(
      `card ${cardId}: ${action} is not allowed in ${lane} — ` +
        `active/verify/done are engine-owned; use the engine doors instead`,
      { cardId, lane, action },
    );
  }
}

// Hold law: hold means pick-later (todo → groom later, groomed → build
// later). Active and verify do not pause — finish or verify-gaps them.
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

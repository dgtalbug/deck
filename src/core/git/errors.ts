import { DeckError } from '../board/errors.ts';

export class GitOpError extends DeckError {
  constructor(operation: string, reason: string, output: string) {
    super(`git ${operation} refused: ${reason}`, { operation, reason, output });
  }
}

export class InvalidBranchError extends DeckError {
  constructor(name: string) {
    super(
      `invalid branch name '${name}' — use letters, digits, '.', '_', '-', '/' ` +
        `(no leading '-', no '..', max 100 chars)`,
      { name },
    );
  }
}

export class GhUnavailableError extends DeckError {
  constructor(output = '') {
    super('gh CLI is missing or not authenticated — PR operations unavailable', { output });
  }
}

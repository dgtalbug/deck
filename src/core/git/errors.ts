// Git operation errors (v0.3.0): one typed failure per refusal class. All
// carry git's captured output in details so the UI can show exactly what git
// said. DeckError gives them the shared message/details shape; http.ts maps
// GhUnavailableError to 503 (capability absent, not a bad request).
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

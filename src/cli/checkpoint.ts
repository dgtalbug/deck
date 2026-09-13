// `deck checkpoint` (E02 DECK-ARCH-010 + review follow-up 7.3): the local
// CLI read/write door over the shared checkpoint core. Documented syntax
// (also in USAGE and README):
//   deck checkpoint <card-id>
//   deck checkpoint <card-id> add "<text>" [--kind decision|gotcha|remaining|blocker]
//                    [--id <entry-id>] [--expect-rev <n>] [--basis <sha16>]
// Card identity is validated against the board; payload bounds and revision
// compare-and-swap live in the core (checkpoint.ts), so CLI, runbooks and
// future doors share one conflict law.
import { UsageError, type ParsedArgs } from './args.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkpointBasis,
  MAX_CHECKPOINT_TEXT,
  readCheckpoint,
  sourceDigest,
  writeCheckpoint,
  type CheckpointKind,
} from '../core/board/checkpoint.ts';
import type { DocumentStore } from '../core/board/store.ts';
import { currentScopeRevision } from '../core/board/scope.ts';
import { isVerbItem } from '../core/board/types.ts';

export async function checkpointCommand(store: DocumentStore, args: ParsedArgs): Promise<string> {
  const cardId = args.positionals[0];
  if (cardId === undefined) throw new UsageError('usage: deck checkpoint <card-id> [add "<text>" --kind <kind>]');
  // Card identity: the checkpoint door refuses unknown cards instead of
  // creating orphan session files.
  const card = store.getCard(cardId);
  const sub = args.positionals[1];
  if (sub === undefined) {
    const state = readCheckpoint(store.projectPath, cardId);
    if (state.entries.length === 0) {
      return state.managed
        ? `card ${cardId} has an empty checkpoint (rev ${state.revision}) — an empty checkpoint is valid`
        : `card ${cardId} has no checkpoint yet — write one with: deck checkpoint ${cardId} add "<text>"`;
    }
    return [
      `card ${cardId} — checkpoint rev ${state.revision}`,
      ...state.entries.map((entry) => `[${entry.id}] ${entry.kind}${entry.basis === 'unknown' ? '' : ` (basis ${entry.basis})`}: ${entry.text}`),
      `write another with --expect-rev ${state.revision} to guard against concurrent edits`,
    ].join('\n');
  }
  if (sub !== 'add') throw new UsageError(`usage: deck checkpoint <card-id> [add "<text>" ...] — unknown subcommand '${sub}'`);
  const text = args.positionals.slice(2).join(' ');
  if (text.trim().length === 0) throw new UsageError(`usage: deck checkpoint <card-id> add "<text>" [--kind <kind>]`);
  if (text.length > MAX_CHECKPOINT_TEXT) {
    throw new UsageError(`checkpoint text exceeds ${MAX_CHECKPOINT_TEXT} code units`);
  }
  const kindFlag = args.flags['kind'];
  const kind: CheckpointKind =
    kindFlag === undefined ? 'decision' : (typeof kindFlag === 'string' ? kindFlag : undefined) as CheckpointKind;
  const revFlag = args.flags['expect-rev'];
  const expectRevision =
    revFlag === undefined ? undefined : Number(typeof revFlag === 'string' ? revFlag : undefined);
  if (revFlag !== undefined && (!Number.isInteger(expectRevision) || (expectRevision as number) < 0)) {
    throw new UsageError('--expect-rev must be a non-negative integer');
  }
  const basisFlag = args.flags['basis'];
  const idFlag = args.flags['id'];
  const specPath = isVerbItem(card) ? join(store.projectPath, card.specPath, 'spec.md') : undefined;
  const sourceRevision = specPath !== undefined && existsSync(specPath)
    ? sourceDigest(readFileSync(specPath, 'utf8'))
    : undefined;
  const basis = typeof basisFlag === 'string'
    ? basisFlag
    : checkpointBasis(isVerbItem(card) ? currentScopeRevision(store.db, cardId) : 0, sourceRevision);
  // CheckpointConflictError passes through: a conflict is a real failure the
  // caller must see, not a usage mistake.
  const state = writeCheckpoint(store.projectPath, cardId, {
    text,
    kind,
    basis,
    id: typeof idFlag === 'string' ? idFlag : undefined,
    expectRevision,
  });
  return `checkpoint written — card ${cardId} rev ${state.revision} (${state.entries.length} ${state.entries.length === 1 ? 'entry' : 'entries'})`;
}

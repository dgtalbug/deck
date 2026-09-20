import { UsageError, flagString, type ParsedArgs } from './args.ts';
import { CheckpointConflictError, readCheckpoint } from '../core/board/checkpoint.ts';
import { MAX_CHECKPOINT_TEXT, type CheckpointKind } from '../core/board/checkpoint.ts';
import { listDurableCheckpoints, recordCheckpoint } from '../core/engine/apply.ts';
import type { DocumentStore } from '../core/board/store.ts';

export async function checkpointCommand(store: DocumentStore, args: ParsedArgs): Promise<string> {
  const cardId = args.positionals[0];
  if (cardId === undefined) throw new UsageError('usage: deck checkpoint <card-id> [add "<text>" --kind <kind>]');
  const card = store.getCard(cardId);
  const sub = args.positionals[1];
  if (sub === undefined) {
    const state = readCheckpoint(store.projectPath, cardId);
    const durable = listDurableCheckpoints(store, cardId);
    if (state.entries.length === 0 && durable.length === 0) {
      return state.managed
        ? `card ${cardId} has an empty checkpoint (rev ${state.revision}) — an empty checkpoint is valid`
        : `card ${cardId} has no checkpoint yet — write one with: deck checkpoint ${cardId} add "<text>"`;
    }
    const lines = [`card ${cardId} — checkpoint rev ${state.revision}`];
    for (const entry of state.entries) {
      lines.push(`[${entry.id}] ${entry.kind}${entry.basis === 'unknown' ? '' : ` (basis ${entry.basis})`}: ${entry.text}`);
    }
    const pending = durable.filter((row) => row.projection === 'pending');
    if (pending.length > 0) {
      lines.push(`durable state holds ${pending.length} checkpoint(s) not yet projected to Markdown (DB authority)`);
    }
    lines.push(`write another with --expect-rev ${state.revision} to guard against concurrent edits`);
    return lines.join('\n');
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
  const durable = listDurableCheckpoints(store, cardId);
  if (expectRevision !== undefined && expectRevision !== (durable[0]?.checkpointRevision ?? 0)) {
    throw new CheckpointConflictError(
      `revision mismatch: durable checkpoint state is at rev ${durable[0]?.checkpointRevision ?? 0}, write expected ${expectRevision} — read again; nothing was changed`,
    );
  }
  void card;
  const record = recordCheckpoint(store, {
    cardId,
    kind,
    text,
    actor: flagString(args.flags, 'by') ?? 'cli',
  });
  const entries = listDurableCheckpoints(store, cardId).length;
  return `checkpoint written — card ${cardId} rev ${record.checkpointRevision} (${entries} ${entries === 1 ? 'entry' : 'entries'}, durable authority + Markdown projection)`;
}

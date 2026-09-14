import { flagString, UsageError, type ParsedArgs } from './args.ts';
import { resolveProject } from './context.ts';
import { getStore } from '../core/projects/stores.ts';
import { captureSourceBaseline, compareSourceBaseline, readSourceBaseline, baselineBytes } from '../core/board/source-baselines.ts';
import { buildAdvisory } from '../core/board/context-advisories.ts';
import type { RunContext } from './main.ts';

const USAGE = 'usage: deck baseline capture <card-id> <path>… | deck baseline read <card-id> | deck baseline compare <card-id> | deck baseline advise <card-id> [--query "<text>"] [--strategy baseline|graph]';

export async function baselineCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const sub = args.positionals[0];
  const cardId = args.positionals[1];
  if (cardId === undefined || cardId.length === 0) throw new UsageError(USAGE);
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);

  if (sub === 'capture') {
    const paths = args.positionals.slice(2);
    if (paths.length === 0) throw new UsageError(USAGE);
    const result = captureSourceBaseline(store, cardId, paths);
    return [
      `baseline ${result.baselineId} (version ${result.version}) captured for ${cardId}`,
      ...result.files.map((file) => `- ${file.path} digest=${file.digest.slice(0, 12)}`),
      'snapshots retained locally under .deck/baselines/ — provenance: exact working-tree bytes at capture time',
    ].join('\n');
  }

  if (sub === 'read') {
    const rows = readSourceBaseline(store.db, cardId);
    if (rows.length === 0) return `no source baseline for ${cardId}`;
    const first = rows[0]!;
    return [
      `baseline version ${first.version} — scope revision ${first.scopeRevision}, graph generation ${first.graphGeneration ?? 'none'}${first.graphFingerprint !== null ? ` (fingerprint ${first.graphFingerprint.slice(0, 12)})` : ''}`,
      ...rows.map((row) => `- ${row.path} digest=${row.digest.slice(0, 12)} snapshot=${baselineBytes(store, row) !== null ? row.snapshotPath : 'UNAVAILABLE'}`),
    ].join('\n');
  }

  if (sub === 'compare') {
    const changes = compareSourceBaseline(store, cardId);
    if (changes.length === 0) return `no source baseline for ${cardId}`;
    return changes.map((change) => `${change.path}: ${change.status}${change.renamedTo !== null ? ` → ${change.renamedTo}` : ''}`).join('\n');
  }

  if (sub === 'advise') {
    const strategy = flagString(args.flags, 'strategy') ?? 'baseline';
    if (strategy !== 'baseline' && strategy !== 'graph') throw new UsageError(USAGE);
    const query = flagString(args.flags, 'query') ?? store.getCard(cardId).title;
    const outcome = buildAdvisory(store, cardId, query, strategy);
    if (outcome === null) return `no source baseline for ${cardId}`;
    return outcome.body;
  }

  throw new UsageError(USAGE);
}

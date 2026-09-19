import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { validateCapabilityDeltas, type CapabilityDeltaSource } from '../core/board/capability-deltas.ts';
import { DeckError } from '../core/board/errors.ts';
import type { ProjectionEligibility } from '../core/board/capability-eligibility.ts';
import {
  applyCapabilityPreview,
  currentCapabilityStatements,
  persistCapabilityPreview,
  previewCapabilityProjection,
  readCapabilityPreview,
} from '../core/board/capability-projection.ts';
import { scopeClassification, snapshotAt } from '../core/board/accepted-scope.ts';
import { getStore } from '../core/projects/stores.ts';
import { resolveProject } from './context.ts';
import { flagString, UsageError, type ParsedArgs } from './args.ts';
import type { RunContext } from './main.ts';
import type { DocumentStore } from '../core/board/store.ts';

const sourceSchema = z.object({
  cardId: z.string(),
  criterionId: z.string(),
  scopeRevision: z.number().int().nonnegative(),
  criterionText: z.string(),
});

const eligibilitySchema = z.object({
  deltaId: z.string(),
  status: z.enum(['eligible', 'ineligible', 'unknown']),
  assurance: z.enum(['hosted', 'local', 'unknown']),
  evidenceId: z.string().nullable(),
  deliveryId: z.string().nullable(),
  reasons: z.array(z.string()),
  sourceDrift: z.enum(['none', 'changed', 'reopened', 'unknown']),
});

const deltaPreviewFileSchema = z.object({
  batchId: z.string(),
  deltas: z.array(z.unknown()).min(1),
  sources: z.array(sourceSchema).min(1),
  eligibility: z.array(eligibilitySchema).min(1),
}).strict();

// Capability deltas may only cite exact accepted Deck-native revisions. The
// file's declared sources are cross-checked against the board: the card must
// hold an accepted revision, the cited revision row must exist, and the
// criterion identity must be a classified criterion of that snapshot. File
// text never overrides board truth.
function verifySourcesAgainstBoard(store: DocumentStore, declared: CapabilityDeltaSource[]): CapabilityDeltaSource[] {
  return declared.map((source) => {
    const classification = scopeClassification(store.db, source.cardId);
    if (classification !== 'accepted') {
      throw new DeckError(
        `capability source card ${source.cardId} has ${classification} scope identity — ` +
          `projection accepts only accepted Deck-native source revisions`,
        { cardId: source.cardId, classification },
      );
    }
    const snapshot = snapshotAt(store.db, source.cardId, source.scopeRevision);
    if (snapshot === null) {
      throw new DeckError(
        `capability source cites revision ${source.scopeRevision} of ${source.cardId} — no accepted revision row exists at that number`,
        { cardId: source.cardId, scopeRevision: source.scopeRevision },
      );
    }
    const criterion = snapshot.criteria.find((item) => item.id === source.criterionId);
    if (criterion === undefined) {
      throw new DeckError(
        `criterion '${source.criterionId}' is not part of accepted revision ${source.scopeRevision} of ${source.cardId}`,
        { cardId: source.cardId, criterionId: source.criterionId, scopeRevision: source.scopeRevision },
      );
    }
    if (criterion.id === 'unclassified' || criterion.state !== 'active') {
      throw new DeckError(
        `criterion '${source.criterionId}' of ${source.cardId} is ${criterion.id === 'unclassified' ? 'unclassified' : criterion.state} — ` +
          `legacy identity cannot feed capability projection`,
        { cardId: source.cardId, criterionId: source.criterionId },
      );
    }
    return { ...source, criterionText: criterion.title };
  });
}

function required(value: string | undefined, usage: string): string {
  if (value === undefined || value.length === 0) throw new UsageError(`usage: deck ${usage}`);
  return value;
}

function readPreviewFile(path: string): {
  batchId: string;
  deltas: unknown[];
  sources: CapabilityDeltaSource[];
  eligibility: Map<string, ProjectionEligibility>;
} {
  try {
    const parsed = deltaPreviewFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    return {
      batchId: parsed.batchId,
      deltas: parsed.deltas,
      sources: parsed.sources,
      eligibility: new Map(parsed.eligibility.map((item) => [item.deltaId, {
        status: item.status,
        assurance: item.assurance,
        evidenceId: item.evidenceId,
        deliveryId: item.deliveryId,
        reasons: item.reasons,
        sourceDrift: item.sourceDrift,
      }])),
    };
  } catch (error) {
    throw new DeckError(`invalid capability delta file '${path}' — ${error instanceof Error ? error.message : String(error)}`, { path });
  }
}

export async function capabilityCommand(args: ParsedArgs, ctx: RunContext): Promise<string | number> {
  const subcommand = required(args.positionals[0], 'capability preview <delta-file> | capability apply <preview-id> --accept');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);

  if (subcommand === 'preview') {
    const path = required(args.positionals[1], 'capability preview <delta-file>');
    const input = readPreviewFile(path);
    const sources = verifySourcesAgainstBoard(store, input.sources);
    const deltas = validateCapabilityDeltas({ batchId: input.batchId, deltas: input.deltas }, sources).deltas;
    const preview = previewCapabilityProjection(currentCapabilityStatements(store), deltas, input.eligibility);
    const stored = persistCapabilityPreview(store, input.batchId, preview);
    return JSON.stringify({
      previewId: stored.id,
      state: preview.conflicts.length === 0 ? 'previewed' : 'conflicted',
      changes: preview.changes,
      conflicts: preview.conflicts,
      baseDigest: preview.baseDigest,
      sourceDigest: preview.sourceDigest,
      contentDigest: preview.contentDigest,
    }, null, 2);
  }

  if (subcommand === 'apply') {
    const previewId = required(args.positionals[1], 'capability apply <preview-id> --accept');
    if (args.flags['accept'] === undefined) {
      throw new UsageError('usage: deck capability apply <preview-id> --accept [--by <actor>] [--rationale <text>]');
    }
    const stored = readCapabilityPreview(store, previewId);
    if (stored === null) throw new DeckError(`capability preview '${previewId}' not found`, { previewId });
    const applied = applyCapabilityPreview(store, previewId, {
      acceptedBy: flagString(args.flags, 'by') ?? 'local',
      rationale: flagString(args.flags, 'rationale') ?? 'explicit CLI acceptance',
    });
    return JSON.stringify(applied, null, 2);
  }

  throw new UsageError('usage: deck capability preview <delta-file> | deck capability apply <preview-id> --accept');
}

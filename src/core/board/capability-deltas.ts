import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DeckError } from './errors.ts';

const stableId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digest = /^[a-f0-9]{16,64}$/;

export const capabilityDeltaSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    deltaId: z.string().regex(stableId),
    capabilityId: z.string().regex(stableId),
    statementId: z.string().regex(stableId),
    statementText: z.string().min(1),
    source: z.object({
      cardId: z.string().regex(stableId),
      criterionId: z.string().regex(stableId),
      scopeRevision: z.number().int().nonnegative(),
      criterionDigest: z.string().regex(digest),
      evidenceId: z.string().regex(stableId),
      deliveryId: z.string().regex(stableId),
    }),
  }),
  z.object({
    op: z.literal('modify'),
    deltaId: z.string().regex(stableId),
    capabilityId: z.string().regex(stableId),
    statementId: z.string().regex(stableId),
    expectedPriorDigest: z.string().regex(digest),
    statementText: z.string().min(1),
    source: z.object({
      cardId: z.string().regex(stableId),
      criterionId: z.string().regex(stableId),
      scopeRevision: z.number().int().nonnegative(),
      criterionDigest: z.string().regex(digest),
      evidenceId: z.string().regex(stableId),
      deliveryId: z.string().regex(stableId),
    }),
  }),
  z.object({
    op: z.literal('remove'),
    deltaId: z.string().regex(stableId),
    capabilityId: z.string().regex(stableId),
    statementId: z.string().regex(stableId),
    expectedPriorDigest: z.string().regex(digest),
    source: z.object({
      cardId: z.string().regex(stableId),
      criterionId: z.string().regex(stableId),
      scopeRevision: z.number().int().nonnegative(),
      criterionDigest: z.string().regex(digest),
      evidenceId: z.string().regex(stableId),
      deliveryId: z.string().regex(stableId),
    }),
  }),
]);

export const capabilityDeltaFileSchema = z.object({
  batchId: z.string().regex(stableId),
  deltas: z.array(capabilityDeltaSchema).min(1),
}).strict();

export type CapabilityDeltaFile = z.infer<typeof capabilityDeltaFileSchema>;
export type CapabilityDelta = z.infer<typeof capabilityDeltaSchema>;

export interface CapabilityDeltaSource {
  cardId: string;
  criterionId: string;
  scopeRevision: number;
  criterionText: string;
}

export function criterionTextDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function validateCapabilityDeltas(
  input: unknown,
  sources: CapabilityDeltaSource[],
): CapabilityDeltaFile {
  const parsed = capabilityDeltaFileSchema.parse(input);
  const sourceMap = new Map(
    sources.map((source) => [`${source.cardId}:${source.criterionId}:${source.scopeRevision}`, source]),
  );
  const seen = new Set<string>();
  for (const delta of parsed.deltas) {
    if (seen.has(delta.deltaId)) {
      throw new DeckError(`duplicate capability delta id '${delta.deltaId}'`, { deltaId: delta.deltaId });
    }
    seen.add(delta.deltaId);
    const source = sourceMap.get(`${delta.source.cardId}:${delta.source.criterionId}:${delta.source.scopeRevision}`);
    if (source === undefined) {
      throw new DeckError(`capability delta '${delta.deltaId}' references unavailable source criterion`, {
        deltaId: delta.deltaId,
        source: delta.source,
      });
    }
    const actualDigest = criterionTextDigest(source.criterionText);
    if (delta.source.criterionDigest !== actualDigest) {
      throw new DeckError(`capability delta '${delta.deltaId}' source criterion digest does not match`, {
        deltaId: delta.deltaId,
        expected: delta.source.criterionDigest,
        actual: actualDigest,
      });
    }
    if (delta.op !== 'remove' && delta.statementText !== source.criterionText) {
      throw new DeckError(
        `capability delta '${delta.deltaId}' statement text must exactly match the source criterion text`,
        { deltaId: delta.deltaId },
      );
    }
  }
  return parsed;
}

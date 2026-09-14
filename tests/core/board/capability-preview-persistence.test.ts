import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { criterionTextDigest, validateCapabilityDeltas } from '../../../src/core/board/capability-deltas.ts';
import type { ProjectionEligibility } from '../../../src/core/board/capability-eligibility.ts';
import {
  currentCapabilityStatements,
  persistCapabilityPreview,
  previewCapabilityProjection,
  readCapabilityPreview,
} from '../../../src/core/board/capability-projection.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { tmpProject } from '../../helpers.ts';

let store: DocumentStore;
let cleanup: () => void;

beforeEach(async () => {
  const project = tmpProject('deck-capability-preview-');
  cleanup = project.cleanup;
  store = await openStore(project.path);
});

afterEach(() => {
  cleanup();
});

const eligible: ProjectionEligibility = {
  status: 'eligible',
  assurance: 'hosted',
  evidenceId: 'evidence:ev-1',
  deliveryId: 'delivery:dl-1',
  reasons: [],
  sourceDrift: 'none',
};

describe('capability preview persistence', () => {
  test('persists content-addressed previews with resolution attribution and no current-state effect', () => {
    const deltas = validateCapabilityDeltas({
      batchId: 'batch:persist',
      deltas: [{
        op: 'add',
        deltaId: 'delta:add-preview',
        capabilityId: 'capability:evidence',
        statementId: 'statement:lineage',
        statementText: 'Evidence bundles preserve source lineage.',
        source: {
          cardId: 'card:story',
          criterionId: 'criterion:c-1',
          scopeRevision: 1,
          criterionDigest: criterionTextDigest('Evidence bundles preserve source lineage.'),
          evidenceId: 'evidence:ev-1',
          deliveryId: 'delivery:dl-1',
        },
      }],
    }, [{ cardId: 'card:story', criterionId: 'criterion:c-1', scopeRevision: 1, criterionText: 'Evidence bundles preserve source lineage.' }]).deltas;
    const preview = previewCapabilityProjection([], deltas, new Map([['delta:add-preview', eligible]]));

    const stored = persistCapabilityPreview(store, 'batch:persist', preview, {
      acceptedBy: 'reviewer',
      rationale: 'source-backed exact text',
    });

    expect(currentCapabilityStatements(store)).toEqual([]);
    expect(readCapabilityPreview(store, stored.id)).toMatchObject({
      id: stored.id,
      resolution: { acceptedBy: 'reviewer', rationale: 'source-backed exact text' },
    });
  });

  test('stored preview content is immutable even if caller mutates the original object', () => {
    const preview = previewCapabilityProjection([], [], new Map());
    const stored = persistCapabilityPreview(store, 'batch:immutable', preview);
    preview.changes.push({
      op: 'add',
      deltaId: 'delta:mutated',
      capabilityId: 'capability:x',
      statementId: 'statement:y',
      before: null,
      after: 'changed after persistence',
    });

    expect(readCapabilityPreview(store, stored.id)?.preview.changes).toEqual([]);
  });
});

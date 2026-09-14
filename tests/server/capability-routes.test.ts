import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import {
  applyCapabilityPreview,
  capabilityStatementDigest,
  persistCapabilityPreview,
  previewCapabilityProjection,
} from '../../src/core/board/capability-projection.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { buildServer } from '../../src/server/serve.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

let registry: ProjectRegistry;
let project: TmpProject;
let store: DocumentStore;
let server: Server<undefined>;
let baseUrl: string;

beforeAll(async () => {
  registry = new ProjectRegistry();
  project = tmpProject('deck-capability-route-');
  registry.register(project.path, 'routeproj');
  store = await openStore(project.path);
  server = buildServer({ registry });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server?.stop(true);
  registry.close();
  project.cleanup();
});

function preview(text: string) {
  const statement = {
    capabilityId: 'capability:evidence',
    statementId: 'statement:lineage',
    text,
    digest: capabilityStatementDigest(text),
    state: 'current' as const,
  };
  return {
    baseDigest: previewCapabilityProjection([], [], new Map()).baseDigest,
    sourceDigest: 'a'.repeat(64),
    contentDigest: previewCapabilityProjection([statement], [], new Map()).contentDigest,
    changes: [{ op: 'add' as const, deltaId: 'delta:add', capabilityId: statement.capabilityId, statementId: statement.statementId, before: null, after: text }],
    conflicts: [],
    statements: [statement],
  };
}

describe('capability routes', () => {
  test('GET /:project/capabilities returns applied statements', async () => {
    const stored = persistCapabilityPreview(store, 'batch:route', preview('Applied capability text.'));
    applyCapabilityPreview(store, stored.id, { acceptedBy: 'reviewer', rationale: 'route fixture' });

    const response = await fetch(`${baseUrl}/routeproj/capabilities`);
    const body = await response.json() as { statements: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.statements).toEqual([{ text: 'Applied capability text.', capabilityId: 'capability:evidence', statementId: 'statement:lineage', digest: expect.any(String), state: 'current', sourceCardId: '', sourceCriterionId: '', sourceScopeRevision: 0, evidenceId: '', deliveryId: '', sourceDrift: 'unknown' }]);
  });

  test('preview route returns conflicts without applying them', async () => {
    const conflicted = persistCapabilityPreview(store, 'batch:conflict-route', {
      ...preview('Conflicted capability text.'),
      conflicts: [{ deltaId: 'delta:add', reason: 'cannot add an existing current statement' }],
    });

    const response = await fetch(`${baseUrl}/routeproj/capabilities/previews/${conflicted.id}`);
    const body = await response.json() as { preview: { conflicts: Array<{ reason: string }> } };
    const current = await fetch(`${baseUrl}/routeproj/capabilities`).then((item) => item.json()) as { statements: Array<{ text: string }> };

    expect(response.status).toBe(200);
    expect(body.preview.conflicts[0]!.reason).toContain('existing current');
    expect(current.statements.map((statement) => statement.text)).not.toContain('Conflicted capability text.');
  });
});

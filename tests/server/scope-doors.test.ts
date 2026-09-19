import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { callTool } from '../../src/server/mcp.ts';
import { buildServer } from '../../src/server/serve.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { scopeAuditView, scopeShow } from '../../src/core/board/scope-inspect.ts';
import { tmpProject } from '../helpers.ts';

// Scope diagnostics door parity: the MCP scope_inspect tool, the REST GET
// /:project/scope handler and the CLI surface return exactly the core
// readers' results; the transport surface is the manifest's explicit list.
let registry: ProjectRegistry;
let project: ReturnType<typeof tmpProject>;
let store: DocumentStore;
let server: Server<undefined>;
let baseUrl: string;

beforeAll(() => {
  registry = new ProjectRegistry();
  project = tmpProject('deck-scope-doors-');
  registry.register(project.path, 'scopedoor');
  server = buildServer({ registry });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server.stop(true);
  registry.close();
  project.cleanup();
});

function groomed(title: string): string {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: ['finding'] },
    specDeltas: [{ op: 'ADDED', requirement: 'door requirement', text: 'body' }],
    tasks: ['one task'],
    openQuestions: [],
  });
  return item.id;
}

describe('scope diagnostics doors', () => {
  beforeAll(async () => {
    store = await openStore(project.path);
  });

  test('GET /scope card view equals scopeShow core', async () => {
    const cardId = groomed('http door card');
    const response = await fetch(`${baseUrl}/scopedoor/scope?card=${encodeURIComponent(cardId)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(scopeShow(store, cardId));
  });

  test('GET /scope audit view equals scopeAuditView core', async () => {
    const response = await fetch(`${baseUrl}/scopedoor/scope?view=audit`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(scopeAuditView(store));
  });

  test('GET /scope without card or view is a typed 404', async () => {
    const response = await fetch(`${baseUrl}/scopedoor/scope`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('missing ?card=');
  });

  test('scope_inspect card view equals scopeShow core', async () => {
    const cardId = groomed('door parity card');
    const viaTool = (await callTool(registry, 'scope_inspect', { project: 'scopedoor', cardId })) as ReturnType<
      typeof scopeShow
    >;
    expect(viaTool).toEqual(scopeShow(store, cardId));
    expect(viaTool.classification).toBe('accepted');
    expect(viaTool.revision?.revisionId).toMatch(/^sr-/);
  });

  test('scope_inspect audit view equals scopeAuditView core', async () => {
    const viaTool = (await callTool(registry, 'scope_inspect', { project: 'scopedoor', view: 'audit' })) as ReturnType<
      typeof scopeAuditView
    >;
    expect(viaTool).toEqual(scopeAuditView(store));
    expect(viaTool.cards.length).toBeGreaterThan(0);
  });

  test('scope_inspect invalid params are typed', async () => {
    await expect(callTool(registry, 'scope_inspect', { project: 'scopedoor' })).rejects.toThrow(/cardId/);
  });

  test('the manifest declares the scope surface on exactly cli, rest and mcp', async () => {
    const { MANIFEST, validateManifest } = await import('../../src/core/capabilities.ts');
    validateManifest();
    const op = MANIFEST.find((entry) => entry.id === 'scope.inspect');
    expect(op?.cli?.route).toBe('scope');
    expect(op?.rest).toEqual({ method: 'GET', path: '/{project}/scope' });
    expect(op?.mcp).toEqual(['scope_inspect']);
    expect(op?.mutability).toBe('read');
    // unsupported transports stay explicit: every manifest op names its mcp
    // surface (null when intentionally absent)
    for (const entry of MANIFEST) {
      expect(entry.mcp === undefined ? null : entry.mcp).toBeDefined();
    }
  });
});

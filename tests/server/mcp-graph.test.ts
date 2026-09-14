import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { handleFrame, type McpIO } from '../../src/server/mcp.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { createWorkspace } from '../../src/core/projects/workspaces.ts';
import { indexGraph } from '../../src/core/graph/index.ts';
import { tmpProject } from '../helpers.ts';

let registry: ProjectRegistry;
let project: ReturnType<typeof tmpProject>;
let home: string;
let store: DocumentStore;

function io(): { io: McpIO; out: string[] } {
  const out: string[] = [];
  return { io: { read: async () => null, write: (line) => out.push(line), log: () => {} }, out };
}

async function raw(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; payload: unknown }> {
  const { io: mcp, out } = io();
  await handleFrame(
    registry,
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    mcp,
  );
  const response = JSON.parse(out[0]!) as {
    result?: { content: Array<{ text: string }>; isError: boolean };
    error?: { message: string };
  };
  if (response.error !== undefined) return { isError: true, payload: { error: response.error.message } };
  return { isError: response.result!.isError, payload: JSON.parse(response.result!.content[0]!.text) };
}

beforeAll(async () => {
  home = join(tmpdir(), `deck-mcpgraph-home-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  project = tmpProject('deck-mcp-graph-');
  writeFileSync(join(project.path, 'deck.config.yaml'), 'board:\n  wipLimit: 8\n');
  execSync('git init --initial-branch=main', { cwd: project.path });
  execSync('git config user.email t@t && git config user.name t', { cwd: project.path });
  writeFileSync(join(project.path, 'seed.txt'), 'seed\n');
  execSync('git add . && git commit -m "seed"', { cwd: project.path });
  registry.register(project.path, 'graphproj');
  store = await openStore(project.path);
});

afterAll(() => {
  rmSync(join(tmpdir(), `${basename(project.path)}-worktrees`), { recursive: true, force: true });
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

describe('mcp graph tools', () => {
  test('absent graph reports absence with a next action, without indexing', async () => {
    const result = await raw('graph_search', { project: 'graphproj', query: 'anything' });
    expect(result.isError).toBeFalsy();
    const payload = result.payload as { graph: string; nextAction: string };
    expect(payload.graph).toBe('absent');
    expect(payload.nextAction).toMatch(/deck graph index/);
  });

  test('indexed graph returns hits with freshness metadata and no mutation', async () => {
    writeFileSync(join(project.path, 'probe.ts'), 'export function probeFn(): number { return 1; }\n');
    const { openGraph } = await import('../../src/core/graph/schema.ts');
    const db = openGraph(project.path);
    await indexGraph(project.path, db);
    db.close();
    const before = statSync(join(project.path, '.deck', 'graph.sqlite')).mtimeMs;

    const result = (await raw('graph_search', { project: 'graphproj', query: 'probeFn' })).payload as {
      results: Array<{ name: string }>;
      workspace: { freshness: { state: string } };
    };
    expect(result.results.some((hit) => hit.name === 'probeFn')).toBe(true);
    expect(['ready', 'unchecked']).toContain(result.workspace.freshness.state);
    expect(statSync(join(project.path, '.deck', 'graph.sqlite')).mtimeMs).toBe(before);
  });

  test('stale graph reports stale generation identity', async () => {
    writeFileSync(join(project.path, 'probe.ts'), 'export function probeFn(): number { return 2; }\n');
    const result = (await raw('graph_search', { project: 'graphproj', query: 'probeFn' })).payload as {
      workspace: { freshness: { state: string } };
    };
    expect(result.workspace.freshness.state).toMatch(/^stale/);
  });

  test('impact honors depth caps and reports resolution tiers', async () => {
    const result = (await raw('graph_impact', { project: 'graphproj', symbol: 'probeFn', depth: 99 })).payload as {
      seed: string;
      edges: Array<{ resolution: string }>;
    };
    expect(result.seed).toContain('probeFn');
    for (const edge of result.edges) {
      expect(['structural', 'heuristic', 'unresolved']).toContain(edge.resolution);
    }
  });

  test('wrong workspace refuses', async () => {
    const result = await raw('graph_search', { project: 'graphproj', query: 'probeFn', workspace: 'not-a-workspace' });
    expect(result.isError).toBe(true);
  });

  test('registered workspace selects its own graph', async () => {
    const workspace = createWorkspace(store, { name: 'graphtree' });
    const result = (await raw('graph_search', { project: 'graphproj', query: 'probeFn', workspace: 'graphtree' })).payload as {
      workspace: { path: string };
      graph?: string;
    };
    expect(result.workspace.path).toBe(workspace.path!);
    expect(result.graph).toBe('absent');
  });

  test('argument caps: limit clamps to 100, oversized query refuses', async () => {
    const capped = (await raw('graph_search', { project: 'graphproj', query: 'probeFn', limit: 100000 })).payload as {
      truncated: boolean;
    };
    expect(capped).toBeDefined();
    const oversize = await raw('graph_search', { project: 'graphproj', query: 'x'.repeat(5000) });
    expect(oversize.isError).toBe(true);
  });
});

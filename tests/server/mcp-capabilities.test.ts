import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { handleFrame, TOOLS, MCP_TOOL_PROFILE, type McpIO } from '../../src/server/mcp.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { assignTask } from '../../src/core/board/task-patches.ts';
import { tmpProject } from '../helpers.ts';

let registry: ProjectRegistry;
let project: ReturnType<typeof tmpProject>;
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
  registry = new ProjectRegistry();
  project = tmpProject('deck-mcp-caps-');
  registry.register(project.path, 'capsproj');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

describe('mcp capabilities', () => {
  test('advertised schemas match runtime accept/refuse: required fields are enforced', async () => {
    // task_patch schema says 7 required fields — dropping any one refuses
    for (const omitted of ['cardId', 'taskId', 'expectedRevision', 'owner', 'commandId', 'done']) {
      const full = {
        project: 'capsproj',
        cardId: 'c',
        taskId: 't',
        expectedRevision: 1,
        owner: 'o',
        commandId: 'k',
        done: true,
      };
      const args = { ...full } as Record<string, unknown>;
      delete args[omitted];
      const result = await raw('task_patch', args);
      expect(result.isError).toBe(true);
    }
    // graph tools declare optional bounded numerics — a non-integer depth refuses
    const bad = await raw('graph_impact', { project: 'capsproj', symbol: 'x', depth: 1.5 });
    expect(bad.isError).toBe(true);
  });

  test('descriptor payload stays bounded', () => {
    const size = JSON.stringify(TOOLS).length;
    expect(size).toBeLessThan(16 * 1024);
    expect(size).toBeGreaterThan(1000);
  });

  test('initialize advertises additive tool profile metadata without touching negotiation', async () => {
    const { io: mcp, out } = io();
    await handleFrame(registry, JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-06-18' } }), mcp);
    const response = JSON.parse(out[0]!) as {
      result: { protocolVersion: string; capabilities: { tools: {} }; toolProfile: { version: number; additiveTools: string[] } };
    };
    expect(response.result.protocolVersion).toBe('2025-06-18');
    expect(response.result.capabilities.tools).toEqual({});
    expect(response.result.toolProfile.version).toBe(2);
    expect(response.result.toolProfile.additiveTools.length).toBe(MCP_TOOL_PROFILE.additiveTools.length);
  });

  test('all four original tools still answer real calls', async () => {
    const note = store.addNote('caps original');
    const item = convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'chore',
      refinedTitle: 'caps original',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    assignTask(store, { cardId: item.id, taskId: item.tasks[0]!.id, owner: 'o', by: 'human' });
    const { moveLane } = await import('../../src/core/board/lanes.ts');
    moveLane(store, item.id, 'active', 'engine');

    expect(((await raw('board_view', { project: 'capsproj' })).payload as { lanes: unknown[] }).lanes).toBeDefined();
    expect(((await raw('next_digest', { project: 'capsproj' })).payload as { context: string }).context).toBeDefined();
    const sync = await raw('task_sync', { project: 'capsproj', cardId: item.id, result: 'clean' });
    expect(sync.isError).toBeFalsy();
    const verify = await raw('verify', { project: 'capsproj', cardId: item.id });
    expect(verify.isError).toBeFalsy();
  });

  test('stream survives errors across many sequential calls', async () => {
    for (let i = 0; i < 5; i++) {
      await raw('verify', { project: 'capsproj', cardId: 'missing-card' });
    }
    const ok = await raw('board_view', { project: 'capsproj' });
    expect(ok.isError).toBeFalsy();
  });
});

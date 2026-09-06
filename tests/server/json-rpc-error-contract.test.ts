import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { handleFrame, type McpIO } from '../../src/server/mcp.ts';
import { tmpProject } from '../helpers.ts';

// mcp-door — the paired file for the "JSON-RPC error contract" requirement:
// protocol codes for unknown method/tool/bad params, typed core errors as
// isError:true results, and the stream surviving every one of them.
let registry: ProjectRegistry;
let project: ReturnType<typeof tmpProject>;

function io(): { io: McpIO; out: string[] } {
  const out: string[] = [];
  return { out, io: { read: async () => null, write: (line) => out.push(line), log: () => {} } };
}

beforeAll(() => {
  registry = new ProjectRegistry();
  project = tmpProject('deck-mcp-errors-');
  registry.register(project.path, 'errproj');
});

afterAll(() => {
  project.cleanup();
});

describe('json-rpc error contract', () => {
  test('unknown method → -32601', async () => {
    const { io: mcp, out } = io();
    await handleFrame(registry, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope' }), mcp);
    expect(JSON.parse(out[0]!)).toMatchObject({ error: { code: -32601 } });
  });

  test('unknown tool → -32602 invalid params', async () => {
    const { io: mcp, out } = io();
    await handleFrame(
      registry,
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'explode', arguments: {} } }),
      mcp,
    );
    expect(JSON.parse(out[0]!)).toMatchObject({ error: { code: -32602 } });
  });

  test('missing project arg → -32602', async () => {
    const { io: mcp, out } = io();
    await handleFrame(
      registry,
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'board_view', arguments: {} } }),
      mcp,
    );
    expect(JSON.parse(out[0]!)).toMatchObject({ error: { code: -32602 } });
  });

  test('a typed core error becomes isError:true and the stream survives', async () => {
    const { io: mcp, out } = io();
    await handleFrame(
      registry,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'next_digest', arguments: { project: 'errproj' } },
      }),
      mcp,
    );
    const result = JSON.parse(out[0]!) as { result: { isError: boolean; content: Array<{ text: string }> } };
    // empty queue → NotFoundError → isError result (not a protocol error)
    expect(result.result.isError).toBe(true);
    await handleFrame(registry, JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }), mcp);
    expect(JSON.parse(out[1]!)).toMatchObject({ id: 5, result: {} });
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { handleFrame, type McpIO } from '../../src/server/mcp.ts';
import { tmpProject } from '../helpers.ts';

// mcp-door — the paired file for the "MCP stdio server" requirement: the
// ndjson JSON-RPC lifecycle (initialize, notifications/initialized, ping,
// malformed-line resilience) over an in-memory io.
let registry: ProjectRegistry;
let project: ReturnType<typeof tmpProject>;

function io(): { io: McpIO; out: string[]; logs: string[] } {
  const out: string[] = [];
  const logs: string[] = [];
  const pending: string[] = [];
  return {
    out,
    logs,
    io: {
      read: async () => pending.shift() ?? null,
      write: (line) => out.push(line),
      log: (message) => logs.push(message),
    },
  };
}

beforeAll(() => {
  registry = new ProjectRegistry();
  project = tmpProject('deck-mcp-stdio-');
  registry.register(project.path);
});

afterAll(() => {
  project.cleanup();
});

describe('mcp stdio server', () => {
  test('initialize handshake echoes protocol + serverInfo', async () => {
    const { io: mcp, out } = io();
    await handleFrame(registry, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }), mcp);
    const response = JSON.parse(out[0]!) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(response.result.protocolVersion).toBe('2025-06-18');
    expect(response.result.serverInfo.name).toBe('deck');
  });

  test('notifications/initialized produces no response; ping → {}', async () => {
    const { io: mcp, out } = io();
    await handleFrame(registry, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), mcp);
    expect(out).toHaveLength(0);
    await handleFrame(registry, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }), mcp);
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 2, result: {} });
  });

  test('a malformed line answers parse error and the stream continues', async () => {
    const { io: mcp, out, logs } = io();
    await handleFrame(registry, '{not json', mcp);
    expect(JSON.parse(out[0]!)).toMatchObject({ error: { code: -32700 } });
    expect(logs).toHaveLength(1);
    await handleFrame(registry, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }), mcp);
    expect(JSON.parse(out[1]!)).toMatchObject({ id: 3, result: {} });
  });
});

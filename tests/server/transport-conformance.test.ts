// P1-S03 cross-transport conformance — one application operation
// (note.create) exercised through CLI, REST and MCP: valid input produces the
// same domain outcome, invalid input refuses through every transport without
// effects, and error semantics stay normalized despite transport formatting.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { runCli } from '../../src/cli/main.ts';
import { handleFrame, type McpIO } from '../../src/server/mcp.ts';
import { tmpProject } from '../helpers.ts';

let server: Server<undefined>;
let registry: ProjectRegistry;
let home: string;
let project: ReturnType<typeof tmpProject>;
let store: DocumentStore;
let baseUrl: string;
let cliOut: string[];
let cliErr: string[];

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

async function mcpCall(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; payload: unknown }> {
  const lines: string[] = [];
  const io: McpIO = { read: async () => null, write: (line) => lines.push(line), log: () => {} };
  await handleFrame(
    registry,
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    io,
  );
  const response = JSON.parse(lines[0]!) as {
    result?: { content: Array<{ text: string }>; isError: boolean };
    error?: { message: string };
  };
  if (response.error !== undefined) {
    return { isError: true, payload: { error: response.error.message } };
  }
  return { isError: response.result!.isError, payload: JSON.parse(response.result!.content[0]!.text) };
}

function runCliArgv(argv: string[]): Promise<number> {
  return runCli(argv, {
    registry,
    cwd: project.path,
    io: { out: (t) => cliOut.push(t), err: (t) => cliErr.push(t) },
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'deck-conformance-home-'));
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  project = tmpProject('deck-conformance-');
  registry.register(project.path, 'confproj');
  store = await openStore(project.path);
  server = buildServer({ registry });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server.stop(true);
  registry.close();
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

describe('note.create cross-transport conformance', () => {
  test('valid input through each transport lands the same domain outcome', async () => {
    cliOut = [];
    cliErr = [];
    expect(await runCliArgv(['note', 'cli note'])).toBe(0);
    const cliId = cliOut[0]!.trim();

    const http = await req('POST', '/confproj/notes', { title: 'http note' });
    expect(http.status).toBe(201);
    const httpBody = (await http.json()) as { id: string };
    expect(httpBody.id).toBeDefined();

    const mcp = await mcpCall('note_capture', { project: 'confproj', title: 'mcp note' });
    expect(mcp.isError).toBeFalsy();
    const mcpBody = mcp.payload as { id: string };
    expect(mcpBody.id).toBeDefined();

    const titles = new Set(store.listCards('todo').map((card) => card.title));
    expect(titles.has('cli note')).toBe(true);
    expect(titles.has('http note')).toBe(true);
    expect(titles.has('mcp note')).toBe(true);
    expect(cliId).not.toBe(httpBody.id);
  });

  test('invalid input refuses through every transport with no effect', async () => {
    const before = store.listCards('todo').length;
    cliOut = [];
    cliErr = [];
    expect(await runCliArgv(['note', ''])).toBe(1);
    expect(cliErr.join('\n')).toContain('invalid arguments');

    const http = await req('POST', '/confproj/notes', { title: '' });
    expect(http.status).toBe(400);

    const mcp = await mcpCall('note_capture', { project: 'confproj', title: '' });
    expect(mcp.isError).toBe(true);

    expect(store.listCards('todo')).toHaveLength(before);
  });

  test('unknown transport arguments get the same treatment on every surface', async () => {
    // The contract is agreement, not strictness: HTTP and MCP must make the
    // same call on unrecognized keys, and neither may half-execute.
    const http = await req('POST', '/confproj/notes', { title: 'extra key probe', mystery: true });
    const httpRefused = http.status >= 400;
    const mcp = await mcpCall('note_capture', { project: 'confproj', title: 'extra key probe 2', mystery: true });
    const mcpRefused = mcp.isError;
    expect(httpRefused).toBe(mcpRefused);
    const titles = new Set(store.listCards('todo').map((card) => card.title));
    expect(titles.has('extra key probe')).toBe(!httpRefused);
    expect(titles.has('extra key probe 2')).toBe(!mcpRefused);
  });
});

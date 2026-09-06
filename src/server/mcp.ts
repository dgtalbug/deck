// MCP door (mcp-door slice, P2 deck-born): `deck mcp` speaks Model
// Context Protocol on stdio — newline-delimited JSON-RPC 2.0, hand-rolled
// (zero new dependencies, law 3). Tool↔core parity: every tool is one
// direct core call on the same DocumentStore the CLI/HTTP doors use.
import { boardView } from '../core/board/views.ts';
import { nextDigest } from '../core/board/next.ts';
import { applyVerifyResult } from '../core/board/verify.ts';
import { runVerification } from '../core/engine/verify.ts';

import { projectStore } from './stores.ts';
import { DECK_VERSION } from '../version.ts';
import type { ProjectRegistry } from '../core/projects/registry.ts';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

// The pinned v1 tool set — additive-only contract.
const PROJECT_ARG = { type: 'string', description: 'project name (deck projects lists them)' };
export const TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'board_view',
    description: 'The board view: lanes with cards and progress (boardView core)',
    inputSchema: { type: 'object', properties: { project: PROJECT_ARG }, required: ['project'] },
  },
  {
    name: 'next_digest',
    description: 'The WIP-aware next digest with the ≤8k-char context pack (nextDigest core)',
    inputSchema: { type: 'object', properties: { project: PROJECT_ARG }, required: ['project'] },
  },
  {
    name: 'task_sync',
    description: 'Apply an explicit verify result to a card (applyVerifyResult core)',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        cardId: { type: 'string', description: 'card id' },
        result: { type: 'string', description: 'verify result', enum: ['clean', 'gaps'] },
        newTasks: { type: 'array', description: 'gap tasks to append (result=gaps)' },
      },
      required: ['project', 'cardId', 'result'],
    },
  },
  {
    name: 'verify',
    description: 'Computed converge verification for a verify-lane card (runVerification core)',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_ARG, cardId: { type: 'string', description: 'card id' } },
      required: ['project', 'cardId'],
    },
  },
] as const;

export interface McpIO {
  read(): Promise<string | null>; // one line, or null at EOF
  write(line: string): void; // one ndjson frame to stdout
  log(message: string): void; // stderr
}

// Tool dispatch — one core call per tool. Typed core errors become
// isError:true results; the stream never dies on a tool error.
export async function callTool(registry: ProjectRegistry, name: string, params: Record<string, unknown>): Promise<unknown> {
  const projectName = params['project'];
  if (typeof projectName !== 'string' || projectName.length === 0) throw new InvalidParamsError('project');
  const store = await projectStore(registry, projectName);
  switch (name) {
    case 'board_view':
      return boardView(store);
    case 'next_digest':
      return nextDigest(store);
    case 'task_sync': {
      const cardId = params['cardId'];
      const result = params['result'];
      if (typeof cardId !== 'string' || (result !== 'clean' && result !== 'gaps')) {
        throw new InvalidParamsError('cardId/result');
      }
      const newTasks = Array.isArray(params['newTasks']) ? (params['newTasks'] as string[]) : [];
      return applyVerifyResult(store, cardId, result, newTasks);
    }
    case 'verify': {
      const cardId = params['cardId'];
      if (typeof cardId !== 'string') throw new InvalidParamsError('cardId');
      const outcome = await runVerification(store, cardId);
      return { result: outcome.result, gaps: outcome.gaps };
    }
    default:
      throw new MethodNotFound();
  }
}

class MethodNotFound extends Error {
  constructor() {
    super('method not found');
  }
}
class InvalidParamsError extends Error {
  constructor(field: string) {
    super(`invalid params: ${field}`);
  }
}

function toolResult(payload: unknown, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError };
}

function errorResponse(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

// The loop: one line in, one response out (notifications get none).
export async function handleFrame(registry: ProjectRegistry, line: string, io: McpIO): Promise<void> {
  let frame: JsonRpcRequest;
  try {
    frame = JSON.parse(line) as JsonRpcRequest;
  } catch {
    io.log(`parse error: ${line.slice(0, 200)}`);
    io.write(errorResponse(null, -32700, 'parse error'));
    return;
  }
  const id = typeof frame?.id === 'number' || typeof frame?.id === 'string' ? frame.id : null;
  try {
    switch (frame?.method) {
      case 'initialize': {
        const requested = (frame.params as { protocolVersion?: string } | undefined)?.protocolVersion;
        io.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              protocolVersion: requested ?? '2025-06-18',
              capabilities: { tools: {}, listChanged: false },
              serverInfo: { name: 'deck', version: DECK_VERSION },
            },
          }),
        );
        return;
      }
      case 'notifications/initialized':
        return; // accepted, ignored, never answered
      case 'ping':
        io.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }));
        return;
      case 'tools/list':
        io.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { tools: TOOLS } }));
        return;
      case 'tools/call': {
        const params = frame.params as { name?: string; arguments?: unknown } | undefined;
        if (typeof params?.name !== 'string' || !TOOLS.some((tool) => tool.name === params.name)) {
          io.write(errorResponse(id, -32602, 'invalid params: unknown tool'));
          return;
        }
        try {
          const payload = await callTool(registry, params.name!, (params.arguments ?? {}) as Record<string, unknown>);
          io.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: toolResult(payload) }));
        } catch (error) {
          if (error instanceof InvalidParamsError || error instanceof MethodNotFound) {
            io.write(errorResponse(id, -32602, error.message));
            return;
          }
          // Typed core errors become isError results — the stream survives.
          io.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: frame.id,
              result: toolResult({ error: error instanceof Error ? error.message : String(error) }, true),
            }),
          );
        }
        return;
      }
      default:
        io.write(errorResponse(id, -32601, 'method not found'));
    }
  } catch (error) {
    io.log(`internal error: ${error instanceof Error ? error.message : String(error)}`);
    io.write(errorResponse(id, -32603, 'internal error'));
  }
}

export async function runMcpLoop(registry: ProjectRegistry, io: McpIO): Promise<void> {
  for (;;) {
    const line = await io.read();
    if (line === null) return;
    if (line.trim().length === 0) continue;
    await handleFrame(registry, line, io);
  }
}

// stdio wiring — `deck mcp`.
export function stdioIo(): McpIO {
  const decoder = new TextDecoder();
  let pending = '';
  const chunks: string[] = [];
  let exhausted = false;
  const readers: Array<(value: string | null) => void> = [];
  const pump = () => {
    while (readers.length > 0) {
      const newline = pending.indexOf('\n');
      if (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        readers.shift()!(line);
        continue;
      }
      const chunk = chunks.shift();
      if (chunk !== undefined) {
        pending += chunk;
        continue;
      }
      if (exhausted) {
        const rest = pending;
        pending = '';
        readers.shift()!(rest.length > 0 ? rest : null);
        continue;
      }
      return;
    }
  };
  void (async () => {
    const reader = Bun.stdin.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
      pump();
    }
    exhausted = true;
    pump();
  })();
  return {
    read: () =>
      new Promise<string | null>((resolve) => {
        readers.push(resolve);
        pump();
      }),
    write(line: string) {
      process.stdout.write(`${line}\n`);
    },
    log(message: string) {
      process.stderr.write(`${message}\n`);
    },
  };
}

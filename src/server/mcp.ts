import { boardView } from '../core/board/views.ts';
import { nextDigest } from '../core/board/next.ts';
import { applyExplicitResult } from '../core/board/verify.ts';
import { runVerification } from '../core/engine/verify.ts';
import { convertToVerbItem } from '../core/board/groom.ts';
import { applyTaskPatch, assignTask } from '../core/board/task-patches.ts';
import { scopeAuditView, scopeShow } from '../core/board/scope-inspect.ts';
import {
  acceptHandoff,
  listHandoffs,
  offerHandoff,
} from '../core/engine/handoffs.ts';
import { openGraph, readMeta as readGraphMeta, type GraphStatus } from '../core/graph/schema.ts';
import { graphExists, graphStatus, gitOrigin } from '../core/graph/index.ts';
import { buildEnvelope } from '../core/graph/envelope.ts';
import { findSymbol, impact } from '../core/graph/queries.ts';
import { searchSymbols } from '../core/graph/search.ts';
import { eq } from 'drizzle-orm';
import { epicCriteria, workspaces } from '../core/board/schema.ts';

import { projectStore } from './stores.ts';
import { groomBody } from './routes/cards.ts';
import { DECK_VERSION } from '../version.ts';
import {
  TOOLS,
  MCP_INPUT_MAX,
  GRAPH_SEARCH_DEFAULT,
  GRAPH_SEARCH_MAX,
  GRAPH_IMPACT_DEPTH_DEFAULT,
  GRAPH_IMPACT_DEPTH_MAX,
  MCP_RESULT_CAP_BYTES,
  MCP_TOOL_PROFILE,
  graphTool,
  InvalidParamsError,
} from './mcp-tools.ts';
export { TOOLS, MCP_TOOL_PROFILE } from './mcp-tools.ts';
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
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface McpIO {
  read(): Promise<string | null>; 
  write(line: string): void; 
  log(message: string): void; 
}

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
      return applyExplicitResult(store, cardId, result, newTasks);
    }
    case 'verify': {
      const cardId = params['cardId'];
      if (typeof cardId !== 'string') throw new InvalidParamsError('cardId');
      const outcome = await runVerification(store, cardId);
      return {
        result: outcome.result,
        gaps: outcome.gaps,
        completed: false,
        next: outcome.result === 'clean' ? 'deck archive (prepare) then deck deliver (finalize)' : 'resolve the gaps, then re-verify',
      };
    }
    case 'note_capture': {
      const title = params['title'];
      if (typeof title !== 'string' || title.length === 0) throw new InvalidParamsError('title');
      if (title.length > MCP_INPUT_MAX) throw new InvalidParamsError(`title exceeds ${MCP_INPUT_MAX} chars`);
      return store.addNote(title);
    }
    case 'groom': {
      const body = groomBody.parse({
        proposedVerb: params['proposedVerb'],
        refinedTitle: params['refinedTitle'],
        research: params['research'],
        specDeltas: params['specDeltas'],
        tasks: params['tasks'],
        openQuestions: params['openQuestions'],
      });
      const noteId = params['noteId'];
      if (typeof noteId !== 'string' || noteId.length === 0) throw new InvalidParamsError('noteId');
      return convertToVerbItem(store, { ...body, noteId });
    }
    case 'epic_read': {
      const epicId = params['epicId'];
      if (typeof epicId !== 'string') throw new InvalidParamsError('epicId');
      const epic = store.getEpic(epicId);
      const criteria = store.db.select().from(epicCriteria).where(eq(epicCriteria.epicId, epicId)).all();
      const stories = store.epicStories(epicId).map((card) => ({
        id: card.id,
        title: 'title' in card ? card.title : '',
        lane: 'lane' in card ? card.lane : 'todo',
      }));
      return { epic, criteria, stories };
    }
    case 'task_patch': {
      const cardId = params['cardId'];
      const taskId = params['taskId'];
      const owner = params['owner'];
      const commandId = params['commandId'];
      const expectedRevision = params['expectedRevision'];
      const done = params['done'];
      if (typeof cardId !== 'string' || typeof taskId !== 'string') throw new InvalidParamsError('cardId/taskId');
      if (typeof owner !== 'string' || typeof commandId !== 'string') throw new InvalidParamsError('owner/commandId');
      if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw new InvalidParamsError('expectedRevision');
      }
      if (typeof done !== 'boolean') throw new InvalidParamsError('done');
      return applyTaskPatch(store, { cardId, taskId, expectedRevision, owner, commandId, done });
    }
    case 'handoff_offer': {
      const cardId = params['cardId'];
      const taskId = params['taskId'];
      const sender = params['sender'];
      const recipient = params['recipient'];
      if (typeof cardId !== 'string' || typeof taskId !== 'string') throw new InvalidParamsError('cardId/taskId');
      if (typeof sender !== 'string' || typeof recipient !== 'string') throw new InvalidParamsError('sender/recipient');
      const remainingWork = params['remainingWork'];
      const evidenceIds = params['evidenceIds'];
      return offerHandoff(store, {
        cardId,
        taskId,
        sender,
        recipient,
        remainingWork: typeof remainingWork === 'string' ? remainingWork : undefined,
        evidenceIds: Array.isArray(evidenceIds) ? (evidenceIds as string[]) : undefined,
      });
    }
    case 'handoff_accept': {
      const handoffId = params['handoffId'];
      const recipient = params['recipient'];
      if (typeof handoffId !== 'string' || typeof recipient !== 'string') throw new InvalidParamsError('handoffId/recipient');
      return acceptHandoff(store, { handoffId, recipient });
    }
    case 'handoff_status': {
      const cardId = params['cardId'];
      return listHandoffs(store, typeof cardId === 'string' && cardId.length > 0 ? { cardId } : undefined);
    }
    case 'scope_inspect': {
      const view = params['view'];
      if (view === 'audit') return scopeAuditView(store);
      const cardId = params['cardId'];
      if (typeof cardId !== 'string' || cardId.length === 0) throw new InvalidParamsError('cardId (or view=audit)');
      return scopeShow(store, cardId);
    }
    case 'graph_search':
      return graphTool(store, params, (db, graphPath, status, staleInspection) => {
        const query = params['query'];
        if (typeof query !== 'string' || query.trim().length === 0) throw new InvalidParamsError('query');
        if (query.length > MCP_INPUT_MAX) throw new InvalidParamsError(`query exceeds ${MCP_INPUT_MAX} chars`);
        const requested = params['limit'];
        const limit =
          typeof requested === 'number' && Number.isInteger(requested)
            ? Math.min(Math.max(requested, 1), GRAPH_SEARCH_MAX)
            : GRAPH_SEARCH_DEFAULT;
        const hits = searchSymbols(db, query, limit + 1);
        return buildEnvelope(db, {
          projectPath: graphPath,
          origin: gitOrigin(graphPath),
          status,
          query: { text: query, limit },
          truncated: hits.length > limit,
          staleInspection,
          generationBefore: readGraphMeta(db)?.generation ?? 0,
          result: hits.slice(0, limit),
        });
      });
    case 'graph_impact': {
      const symbol = params['symbol'];
      if (typeof symbol !== 'string' || symbol.trim().length === 0) throw new InvalidParamsError('symbol');
      if (symbol.length > MCP_INPUT_MAX) throw new InvalidParamsError(`symbol exceeds ${MCP_INPUT_MAX} chars`);
      const requestedDepth = params['depth'];
      if (requestedDepth !== undefined && (typeof requestedDepth !== 'number' || !Number.isInteger(requestedDepth))) {
        throw new InvalidParamsError('depth must be an integer');
      }
      return graphTool(store, params, (db, graphPath, status, staleInspection) => {
        const depth =
          typeof requestedDepth === 'number'
            ? Math.min(Math.max(requestedDepth, 1), GRAPH_IMPACT_DEPTH_MAX)
            : GRAPH_IMPACT_DEPTH_DEFAULT;
        const direction = params['direction'];
        const dir = direction === 'in' || direction === 'out' ? direction : 'both';
        const seeds = findSymbol(db, symbol);
        if (seeds.length === 0) {
          return { workspace: { path: graphPath, freshness: { state: status.state, reason: status.reason ?? null } }, seed: symbol, found: false, nodes: [], edges: [] };
        }
        const seed = seeds[0]!;
        const result = impact(db, seed.id, { maxDepth: depth, direction: dir });
        // Same shared envelope as core and CLI: identity, freshness, applied
        // filters, uncertainty and truncation travel with every result.
        return buildEnvelope(db, {
          projectPath: graphPath,
          origin: gitOrigin(graphPath),
          status,
          query: { seedFqn: seed.fqn, direction: result.direction, kinds: result.kinds, depth },
          truncated: result.truncated,
          staleInspection,
          generationBefore: readGraphMeta(db)?.generation ?? 0,
          result: { seed: seed.fqn, found: true, nodes: result.nodes, edges: result.edges, cap: result.cap },
        });
      });
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

function toolResult(payload: unknown, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError };
}

function errorResponse(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

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
              toolProfile: MCP_TOOL_PROFILE,
            },
          }),
        );
        return;
      }
      case 'notifications/initialized':
        return; 
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

import { eq } from 'drizzle-orm';
import { workspaces } from '../core/board/schema.ts';
import { graphExists, graphStatus } from '../core/graph/index.ts';
import { openGraph, readMeta } from '../core/graph/schema.ts';
import type { DocumentStore } from '../core/board/store.ts';
import type { Database } from 'bun:sqlite';

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const PROJECT_ARG = { type: 'string', description: 'project name (deck projects lists them)' };
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
    description:
      'Apply an explicit verify result to a card (applyExplicitResult core — verbs hold in verify on clean, tweaks close; completion is delivery finalization alone: deck archive prepares (pending), deck deliver completes)',
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
  {
    name: 'note_capture',
    description: 'Capture a note into the board todo lane (addNote core); groom it later',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        title: { type: 'string', description: 'note text (≤4 KiB)' },
      },
      required: ['project', 'title'],
    },
  },
  {
    name: 'groom',
    description:
      'Groom a note into a verb item with research, spec deltas and tasks (convertToVerbItem core — same validation as HTTP/CLI)',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        noteId: { type: 'string', description: 'note id to groom' },
        proposedVerb: { type: 'string', description: 'verb name' },
        refinedTitle: { type: 'string', description: 'refined story title' },
        research: {
          type: 'object',
          description: 'research payload (codebaseFindings, rca, blastRadius, story, sections)',
          properties: {
            codebaseFindings: { type: 'array', items: { type: 'string' } },
          },
        },
        specDeltas: {
          type: 'array',
          description: 'spec deltas',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['ADDED', 'MODIFIED', 'REMOVED'] },
              requirement: { type: 'string' },
              text: { type: 'string' },
            },
          },
        },
        tasks: { type: 'array', items: { type: 'string' }, description: 'task titles' },
        openQuestions: { type: 'array', items: { type: 'string' } },
      },
      required: ['project', 'noteId', 'proposedVerb', 'refinedTitle', 'research', 'specDeltas', 'tasks', 'openQuestions'],
    },
  },
  {
    name: 'epic_read',
    description: 'Read an epic: intent, criteria and story tree (board core)',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_ARG, epicId: { type: 'string', description: 'epic id' } },
      required: ['project', 'epicId'],
    },
  },
  {
    name: 'task_patch',
    description:
      'Revision-checked checkbox patch for one assigned task (applyTaskPatch core); title/scope edits go through grooming, task_sync stays verification-only',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        cardId: { type: 'string', description: 'card id' },
        taskId: { type: 'string', description: 'task id' },
        expectedRevision: { type: 'number', description: 'task revision you read' },
        owner: { type: 'string', description: 'owner handle of the assignment' },
        commandId: { type: 'string', description: 'idempotency key' },
        done: { type: 'boolean', description: 'new checkbox state' },
      },
      required: ['project', 'cardId', 'taskId', 'expectedRevision', 'owner', 'commandId', 'done'],
    },
  },
  {
    name: 'handoff_offer',
    description: 'Offer a task handoff capturing scope/checkpoint basis (offerHandoff core)',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        cardId: { type: 'string' },
        taskId: { type: 'string' },
        sender: { type: 'string', description: 'current owner handle' },
        recipient: { type: 'string', description: 'intended new owner handle' },
        remainingWork: { type: 'string', description: 'remaining work notes' },
        evidenceIds: { type: 'array', items: { type: 'string' }, description: 'evidence record ids' },
      },
      required: ['project', 'cardId', 'taskId', 'sender', 'recipient'],
    },
  },
  {
    name: 'handoff_accept',
    description: 'Accept an offered handoff after reviewing the current basis (acceptHandoff core)',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        handoffId: { type: 'string' },
        recipient: { type: 'string', description: 'accepting owner handle' },
      },
      required: ['project', 'handoffId', 'recipient'],
    },
  },
  {
    name: 'handoff_status',
    description: 'List handoffs, optionally filtered by card (listHandoffs core)',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_ARG, cardId: { type: 'string', description: 'optional card filter' } },
      required: ['project'],
    },
  },
  {
    name: 'graph_search',
    description:
      'FTS5 symbol search over the project graph (default 20, max 100 results); reports workspace identity, freshness and truncation; never indexes',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        query: { type: 'string', description: 'symbol text (≤4 KiB)' },
        limit: { type: 'number', description: 'result cap (default 20, max 100)' },
        workspace: { type: 'string', description: 'workspace id/name or path of an attached worktree (default canonical)' },
        allowStale: { type: 'boolean', description: 'read a stale graph labeled as stale inspection instead of refusing' },
      },
      required: ['project', 'query'],
    },
  },
  {
    name: 'graph_impact',
    description:
      'Blast-radius neighborhood of a symbol (depth default 1, max 3; capped results, budgeted truncation); reports workspace identity, freshness/generation and resolution tiers; never indexes',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        symbol: { type: 'string', description: 'symbol name or fqn (≤4 KiB)' },
        depth: { type: 'number', description: 'hop depth (default 1, max 3)' },
        direction: { type: 'string', enum: ['in', 'out', 'both'] },
        workspace: { type: 'string', description: 'workspace id/name or path of an attached worktree (default canonical)' },
        allowStale: { type: 'boolean', description: 'read a stale graph labeled as stale inspection instead of refusing' },
      },
      required: ['project', 'symbol'],
    },
  },
] as const;

export const MCP_TOOL_PROFILE = {
  version: 2,
  additiveTools: [
    'note_capture',
    'groom',
    'epic_read',
    'task_patch',
    'handoff_offer',
    'handoff_accept',
    'handoff_status',
    'graph_search',
    'graph_impact',
  ],
  originalTools: ['board_view', 'next_digest', 'task_sync', 'verify'],
} as const;

export const MCP_INPUT_MAX = 4096;
export const MCP_RESULT_CAP_BYTES = 32 * 1024;
export const GRAPH_SEARCH_DEFAULT = 20;
export const GRAPH_SEARCH_MAX = 100;
export const GRAPH_IMPACT_DEPTH_DEFAULT = 1;
export const GRAPH_IMPACT_DEPTH_MAX = 3;

export class InvalidParamsError extends Error {
  constructor(field: string) {
    super(`invalid params: ${field}`);
  }
}

export function resolveGraphPath(
  store: import('../core/board/store.ts').DocumentStore,
  workspaceArg: unknown,
): string {
  if (workspaceArg === undefined || workspaceArg === null || workspaceArg === '') return store.projectPath;
  if (typeof workspaceArg !== 'string') throw new InvalidParamsError('workspace');
  const rows = store.db.select().from(workspaces).where(eq(workspaces.branch, `deck/w/${workspaceArg}`)).all();
  const byId = rows.find((row) => row.id === workspaceArg);
  const byName = rows[0];
  const byPath = store.db.select().from(workspaces).where(eq(workspaces.path, workspaceArg)).get();
  const row = byId ?? byName ?? byPath;
  if (row === undefined || row.state !== 'attached' || row.path === null) {
    throw new InvalidParamsError(`workspace '${workspaceArg}' is not an attached workspace of this project`);
  }
  return row.path;
}

export class GraphStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphStaleError';
  }
}

export function graphTool(
  store: import('../core/board/store.ts').DocumentStore,
  params: Record<string, unknown>,
  run: (
    db: import('bun:sqlite').Database,
    graphPath: string,
    status: import('../core/graph/schema.ts').GraphStatus,
    staleInspection: boolean,
  ) => unknown,
): unknown {
  const graphPath = resolveGraphPath(store, params['workspace']);
  if (!graphExists(graphPath)) {
    return {
      graph: 'absent',
      workspace: { path: graphPath },
      nextAction: `run 'deck graph index' in ${graphPath} — graph reads never index implicitly`,
    };
  }
  const db = openGraph(graphPath);
  try {
    const status = graphStatus(graphPath, db);
    const allowStale = params['allowStale'] === true;
    // Same freshness policy as core and CLI: refuse absent/stale/unverifiable
    // graphs by default; explicit stale inspection passes labeled.
    if (status.state !== 'ready' && !allowStale) {
      throw new GraphStaleError(
        `graph is ${status.state}${status.reason !== undefined ? ` — ${status.reason}` : ''}; ` +
          `run 'deck graph index' or pass allowStale: true for labeled stale inspection`,
      );
    }
    const meta = readMeta(db);
    const freshness = { state: status.state, reason: status.reason, generation: meta?.generation ?? null, staleInspection: allowStale && status.state !== 'ready' };
    const payload = run(db, graphPath, status, allowStale && status.state !== 'ready');
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded, 'utf8') > MCP_RESULT_CAP_BYTES) {
      const budget = { graph: 'truncated', reason: `response exceeds ${MCP_RESULT_CAP_BYTES} bytes` };
      return { ...budget, workspace: (payload as { workspace?: unknown }).workspace };
    }
    return payload;
  } finally {
    db.close();
  }
}

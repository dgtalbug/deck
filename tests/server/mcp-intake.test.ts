import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { handleFrame, type McpIO } from '../../src/server/mcp.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { assignTask } from '../../src/core/board/task-patches.ts';
import { tmpProject } from '../helpers.ts';

let registry: ProjectRegistry;
let project: ReturnType<typeof tmpProject>;
let store: DocumentStore;

function io(): { io: McpIO; out: string[] } {
  const out: string[] = [];
  return { io: { read: async () => null, write: (line) => out.push(line), log: () => {} }, out };
}

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { io: mcp, out } = io();
  await handleFrame(
    registry,
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    mcp,
  );
  const response = JSON.parse(out[0]!) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: { message: string } };
  if (response.error !== undefined) throw new Error(response.error.message);
  const payload = JSON.parse(response.result!.content[0]!.text) as unknown;
  if (response.result!.isError) throw new Error(String((payload as { error?: string }).error ?? payload));
  return payload;
}

beforeAll(async () => {
  registry = new ProjectRegistry();
  project = tmpProject('deck-mcp-intake-');
  registry.register(project.path, 'intakeproj');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

describe('mcp intake', () => {
  test('MCP-only capture → groom flow matches shared core behavior', async () => {
    const note = (await call('note_capture', { project: 'intakeproj', title: 'fix the mcp flicker' })) as { id: string };
    expect(note.id).toBeDefined();

    const item = (await call('groom', {
      project: 'intakeproj',
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'stabilize rendering loop',
      research: { codebaseFindings: ['renderer drops frames under load'] },
      specDeltas: [{ op: 'ADDED', requirement: 'Stability', text: 'no flicker under load' }],
      tasks: ['investigate', 'fix', 'test'],
      openQuestions: [],
    })) as { id: string; tasks: Array<{ done: boolean }> };

    expect(item.tasks).toHaveLength(3);
    expect(store.getVerbItem(item.id).tasks.every((task) => !task.done)).toBe(true);
  });

  test('invalid groom payload refuses without partial writes, stream stays usable', async () => {
    const note = (await call('note_capture', { project: 'intakeproj', title: 'another note' })) as { id: string };
    await expect(
      call('groom', {
        project: 'intakeproj',
        noteId: note.id,
        proposedVerb: 'NOT A VERB',
        refinedTitle: 'x',
        research: { codebaseFindings: [] },
        specDeltas: [],
        tasks: [],
        openQuestions: [],
      }),
    ).rejects.toThrow();
    expect(() => store.getNote(note.id)).not.toThrow();

    // stream survives the error — a later call works
    const board = (await call('note_capture', { project: 'intakeproj', title: 'after error' })) as { id: string };
    expect(board.id).toBeDefined();
  });

  test('epic_read returns intent, criteria and stories', async () => {
    const epic = store.addEpic('intake epic');
    const note = store.addNote('epic story');
    const item = (await call('groom', {
      project: 'intakeproj',
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'epic story',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    })) as { id: string };
    store.setEpic(item.id, epic.id);
    const read = (await call('epic_read', { project: 'intakeproj', epicId: epic.id })) as {
      epic: { id: string };
      stories: Array<{ id: string }>;
    };
    expect(read.epic.id).toBe(epic.id);
    expect(read.stories.map((story) => story.id)).toContain(item.id);
  });

  test('oversized input refuses before effects', async () => {
    await expect(call('note_capture', { project: 'intakeproj', title: 'x'.repeat(5000) })).rejects.toThrow();
  });

  test('task_patch over MCP refuses an unassigned task and succeeds after assignment', async () => {
    const note = store.addNote('patch probe');
    const item = (await call('groom', {
      project: 'intakeproj',
      noteId: note.id,
      proposedVerb: 'chore',
      refinedTitle: 'patch probe',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    })) as { id: string; tasks: Array<{ id: string }> };
    const taskId = item.tasks[0]!.id;

    await expect(
      call('task_patch', { project: 'intakeproj', cardId: item.id, taskId, expectedRevision: 1, owner: 'mcp-agent', commandId: 'm1', done: true }),
    ).rejects.toThrow(/no assigned owner/);

    const assignment = assignTask(store, { cardId: item.id, taskId, owner: 'mcp-agent', by: 'human' });
    const patched = (await call('task_patch', {
      project: 'intakeproj',
      cardId: item.id,
      taskId,
      expectedRevision: assignment.revision,
      owner: 'mcp-agent',
      commandId: 'm2',
      done: true,
    })) as { revision: number; duplicate: boolean };
    expect(patched.duplicate).toBe(false);
    expect(store.getVerbItem(item.id).tasks[0]!.done).toBe(true);
  });
});

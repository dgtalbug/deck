import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { handleFrame, type McpIO } from '../../src/server/mcp.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { applyExplicitResult } from '../../src/core/board/verify.ts';
import { assignTask, getTaskAssignment } from '../../src/core/board/task-patches.ts';
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
  const response = JSON.parse(out[0]!) as { result: { content: Array<{ text: string }>; isError: boolean } };
  return { isError: response.result.isError, payload: JSON.parse(response.result.content[0]!.text) };
}

beforeAll(async () => {
  registry = new ProjectRegistry();
  project = tmpProject('deck-mcp-collab-');
  registry.register(project.path, 'collabproj');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

function groomed(title: string): { cardId: string; taskId: string } {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'chore',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['one'],
    openQuestions: [],
  });
  return { cardId: item.id, taskId: item.tasks[0]!.id };
}

describe('mcp collaboration tools', () => {
  test('real tools/call frames: offer → status → accept → stale patch refuses', async () => {
    const { cardId, taskId } = groomed('handoff over mcp');
    const assignment = assignTask(store, { cardId, taskId, owner: 'agent-a', by: 'human' });

    const offer = (await raw('handoff_offer', {
      project: 'collabproj',
      cardId,
      taskId,
      sender: 'agent-a',
      recipient: 'agent-b',
      remainingWork: 'close the loop',
    })).payload as { id: string; state: string };
    expect(offer.state).toBe('offered');

    const status = (await raw('handoff_status', { project: 'collabproj', cardId })).payload as Array<{ id: string }>;
    expect(status.some((row) => row.id === offer.id)).toBe(true);

    const accepted = (await raw('handoff_accept', { project: 'collabproj', handoffId: offer.id, recipient: 'agent-b' })).payload as {
      state: string;
    };
    expect(accepted.state).toBe('accepted');
    expect(getTaskAssignment(store, cardId, taskId).owner).toBe('agent-b');

    const stale = await raw('task_patch', {
      project: 'collabproj',
      cardId,
      taskId,
      expectedRevision: assignment.revision,
      owner: 'agent-a',
      commandId: 'stale-1',
      done: true,
    });
    expect(stale.isError).toBe(true);

    const duplicate = (await raw('task_patch', {
      project: 'collabproj',
      cardId,
      taskId,
      expectedRevision: getTaskAssignment(store, cardId, taskId).revision,
      owner: 'agent-b',
      commandId: 'fresh-1',
      done: true,
    })).payload as { duplicate: boolean };
    expect(duplicate.duplicate).toBe(false);
    const replay = (await raw('task_patch', {
      project: 'collabproj',
      cardId,
      taskId,
      expectedRevision: getTaskAssignment(store, cardId, taskId).revision - 1,
      owner: 'agent-b',
      commandId: 'fresh-1',
      done: true,
    })).payload as { duplicate: boolean };
    expect(replay.duplicate).toBe(true);
  });

  test('task_sync stays verification-only — no checkbox patch, no done transition implied', async () => {
    const { cardId, taskId } = groomed('task sync alias');
    assignTask(store, { cardId, taskId, owner: 'agent-a', by: 'human' });
    const { moveLane } = await import('../../src/core/board/lanes.ts');
    moveLane(store, cardId, 'active', 'engine');
    const card = applyExplicitResult(store, cardId, 'clean', []);
    expect('lane' in card && card.lane).toBe('verify');
    expect(store.getVerbItem(cardId).tasks[0]!.done).toBe(false);
  });

  test('stream survives tool errors', async () => {
    const bad = await raw('handoff_accept', { project: 'collabproj', handoffId: 'ho-nonexistent', recipient: 'x' });
    expect(bad.isError).toBe(true);
    const ok = await raw('handoff_status', { project: 'collabproj' });
    expect(ok.isError).toBeFalsy();
  });
});

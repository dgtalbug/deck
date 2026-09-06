import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { callTool } from '../../src/server/mcp.ts';
import { boardView } from '../../src/core/board/views.ts';
import { nextDigest } from '../../src/core/board/next.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { applyVerifyResult } from '../../src/core/board/verify.ts';
import { runVerification } from '../../src/core/engine/verify.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { tmpProject } from '../helpers.ts';

// mcp-door — the paired file for the "Tool-to-core parity" requirement: a
// tools/call payload equals the corresponding core function's return on
// the same store (one db, four doors).
let registry: ProjectRegistry;
let project: ReturnType<typeof tmpProject>;
let store: DocumentStore;

beforeAll(async () => {
  registry = new ProjectRegistry();
  project = tmpProject('deck-mcp-parity-');
  registry.register(project.path, 'parityproj');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

function groomed(title: string, tasks: string[]): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks,
    openQuestions: [],
  });
  return note.id;
}

describe('tool-to-core parity', () => {
  test('board_view equals boardView(store)', async () => {
    groomed('parity board card', ['one']);
    const viaTool = await callTool(registry, 'board_view', { project: 'parityproj' });
    expect(viaTool).toEqual(boardView(store));
  });

  test('next_digest equals nextDigest(store)', async () => {
    const viaTool = await callTool(registry, 'next_digest', { project: 'parityproj' });
    const direct = nextDigest(store);
    expect(JSON.parse(JSON.stringify(viaTool))).toEqual(JSON.parse(JSON.stringify(direct)));
  });

  test('task_sync equals applyVerifyResult; verify equals runVerification', async () => {
    const toolCard = groomed('parity verify tool card', ['do it']);
    moveLane(store, toolCard, 'verify', 'engine');
    const viaTool = await callTool(registry, 'task_sync', { project: 'parityproj', cardId: toolCard, result: 'gaps', newTasks: ['fix it'] });
    const coreCard = groomed('parity verify core card', ['do it']);
    moveLane(store, coreCard, 'verify', 'engine');
    const direct = applyVerifyResult(store, coreCard, 'gaps', ['fix it']);
    expect(viaTool).toMatchObject({ id: toolCard, lane: 'active' });
    expect(direct).toMatchObject({ id: coreCard, lane: 'active' });
    // verify-compute runs on verify-lane cards: a fresh pair, tool vs core.
    const verifyToolCard = groomed('parity verify compute tool', ['do it']);
    moveLane(store, verifyToolCard, 'verify', 'engine');
    const outcome = await callTool(registry, 'verify', { project: 'parityproj', cardId: verifyToolCard });
    const verifyCoreCard = groomed('parity verify compute core', ['do it']);
    moveLane(store, verifyCoreCard, 'verify', 'engine');
    const directRun = await runVerification(store, verifyCoreCard);
    const typed = outcome as { result: string; gaps: Array<{ taskTitle: string }> };
    expect(typed.result).toBe(directRun.result);
    expect(typed.gaps.map((gap) => gap.taskTitle)).toEqual(
      directRun.gaps.map((gap) => gap.taskTitle),
    );
  });
});

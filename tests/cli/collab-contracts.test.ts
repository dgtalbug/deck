// T09 — direct CLI contract tests for task operations, handoff/resume, and
// checkpoints: deck task show|assign|patch, deck handoff offer|accept|cancel|list,
// deck checkpoint. Failures assert the typed message, exit code, and unchanged
// persisted state where applicable.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runCli } from '../../src/cli/main.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

let registry: ProjectRegistry;
let proj: TmpProject;
let store: DocumentStore;
let out: string[];
let err: string[];
const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };

function run(argv: string[]): Promise<number> {
  out = [];
  err = [];
  return runCli(argv, { registry, cwd: proj.path, io });
}

interface GroomedCard {
  id: string;
  taskIds: string[];
}

function groomed(title: string): GroomedCard {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['alpha step', 'beta step'],
    openQuestions: [],
  });
  return { id: item.id, taskIds: item.tasks.map((task) => task.id) };
}

beforeEach(async () => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-cli-collab-');
  registry.register(proj.path);
  store = await openStore(proj.path);
});

afterEach(() => {
  proj.cleanup();
});

describe('deck task', () => {
  test('assign then patch marks done and persists; show exposes the revision', async () => {
    const card = groomed('cover task contracts');
    const taskId = card.taskIds[0]!;
    expect(await run(['task', 'assign', card.id, taskId, '--owner', 'alice'])).toBe(0);
    expect(out[0]).toContain(`task ${taskId} assigned to alice (revision 2)`);

    expect(await run(['task', 'patch', card.id, taskId, '--rev', '2', '--owner', 'alice', '--command', 'cmd-a', '--done', 'true'])).toBe(0);
    expect(out[0]).toContain(`task ${taskId} patched — done=true, revision 3`);

    expect(await run(['task', 'show', card.id, taskId])).toBe(0);
    const shown = JSON.parse(out[0]!) as { revision: number; owner: string };
    expect(shown.owner).toBe('alice');
    expect(shown.revision).toBe(3);
  });

  test('a duplicate command id replays instead of double-patching', async () => {
    const card = groomed('cover task contracts');
    const taskId = card.taskIds[0]!;
    await run(['task', 'assign', card.id, taskId, '--owner', 'alice']);
    await run(['task', 'patch', card.id, taskId, '--rev', '2', '--owner', 'alice', '--command', 'cmd-a', '--done', 'true']);
    expect(
      await run(['task', 'patch', card.id, taskId, '--rev', '2', '--owner', 'alice', '--command', 'cmd-a', '--done', 'true']),
    ).toBe(0);
    expect(out[0]).toContain('replayed (duplicate command)');
    expect(await run(['task', 'show', card.id, taskId])).toBe(0);
    expect((JSON.parse(out[0]!) as { revision: number }).revision).toBe(3);
  });

  test('wrong owner and stale revision are typed failures that change nothing', async () => {
    const card = groomed('cover task contracts');
    const taskId = card.taskIds[0]!;
    await run(['task', 'assign', card.id, taskId, '--owner', 'alice']);

    expect(
      await run(['task', 'patch', card.id, taskId, '--rev', '2', '--owner', 'bob', '--command', 'cmd-b', '--done', 'true']),
    ).toBe(1);
    expect(err[0]).toContain('owner');
    expect(await run(['task', 'patch', card.id, taskId, '--rev', '42', '--owner', 'alice', '--command', 'cmd-c', '--done', 'true'])).toBe(1);
    expect(err[0]).toContain('revision');

    expect(await run(['task', 'show', card.id, taskId])).toBe(0);
    expect((JSON.parse(out[0]!) as { revision: number }).revision).toBe(2);
  });

  test('unknown card/task ids and missing subcommand are typed/usage failures', async () => {
    const card = groomed('cover task contracts');
    expect(await run(['task', 'show', card.id, 't-nope'])).toBe(1);
    expect(err[0]).toContain('not found');
    expect(await run(['task', 'show', 'nope-0000', 't-1'])).toBe(1);
    expect(await run(['task'])).toBe(64);
    expect(err[0]).toContain('usage: deck task');
    expect(await run(['task', 'explode', card.id])).toBe(64);
  });
});

describe('deck handoff', () => {
  test('offer, list, and accept move the task to the recipient', async () => {
    const card = groomed('cover handoff contracts');
    const taskId = card.taskIds[0]!;
    await run(['task', 'assign', card.id, taskId, '--owner', 'alice']);
    expect(
      await run(['handoff', 'offer', card.id, '--task', taskId, '--from', 'alice', '--to', 'bob', '--remaining', 'finish the tests']),
    ).toBe(0);
    expect(out[0]).toContain('offered: alice → bob');
    const handoffId = out[0]!.split(' ')[1]!;

    expect(await run(['handoff', 'list', card.id])).toBe(0);
    expect(out[0]).toContain(`${handoffId} offered alice → bob`);

    expect(await run(['handoff', 'accept', card.id, handoffId, '--as', 'bob'])).toBe(0);
    expect(out[0]).toContain(`task ${taskId} now belongs to bob`);
    expect(await run(['task', 'show', card.id, taskId])).toBe(0);
    expect((JSON.parse(out[0]!) as { owner: string }).owner).toBe('bob');
  });

  test('cancel returns the task to the sender; sender equals recipient is typed', async () => {
    const card = groomed('cover handoff contracts');
    const taskId = card.taskIds[0]!;
    await run(['task', 'assign', card.id, taskId, '--owner', 'alice']);
    await run(['handoff', 'offer', card.id, '--task', taskId, '--from', 'alice', '--to', 'bob', '--remaining', 'later']);
    const handoffId = (out[0] as string).split(' ')[1]!;
    expect(await run(['handoff', 'cancel', card.id, handoffId, '--as', 'alice'])).toBe(0);
    expect(out[0]).toContain('keeps task');

    expect(
      await run(['handoff', 'offer', card.id, '--task', taskId, '--from', 'alice', '--to', 'alice', '--remaining', 'x']),
    ).toBe(1);
    expect(err[0]).toContain('name another owner');
  });

  test('unknown handoff id is a typed not-found failure', async () => {
    const card = groomed('cover handoff contracts');
    expect(await run(['handoff', 'accept', card.id, 'h-nope', '--as', 'bob'])).toBe(1);
    expect(err[0]).toContain('not found');
  });
});

describe('deck checkpoint', () => {
  test('empty read hints, add writes, and stale --expect-rev refuses', async () => {
    const card = groomed('cover checkpoint contracts');
    expect(await run(['checkpoint', card.id])).toBe(0);
    expect(out[0]).toContain(`card ${card.id} has no checkpoint yet`);

    expect(await run(['checkpoint', card.id, 'add', 'decided the contract shape'])).toBe(0);
    expect(out[0]).toContain(`checkpoint written — card ${card.id} rev 1`);
    expect(await run(['checkpoint', card.id])).toBe(0);
    expect(out.join('\n')).toContain('decided the contract shape');
    expect(out.join('\n')).toContain('--expect-rev 1');

    expect(await run(['checkpoint', card.id, 'add', 'second entry', '--expect-rev', '99'])).toBe(1);
    expect(err[0]).toContain('revision mismatch');
    expect(await run(['checkpoint', card.id])).toBe(0);
    expect(out.join('\n')).not.toContain('second entry');
  });

  test('unknown card is a typed failure; empty text is a usage error', async () => {
    expect(await run(['checkpoint', 'nope-0000'])).toBe(1);
    expect(err[0]).toContain('not found');
    const card = groomed('cover checkpoint contracts');
    expect(await run(['checkpoint', card.id, 'add', '   '])).toBe(64);
    expect(err[0]).toContain('usage: deck checkpoint');
  });
});

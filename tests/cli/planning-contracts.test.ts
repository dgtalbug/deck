// T09 — direct CLI contract tests for planning/dependency commands:
// deck deps (list/add/remove/set) and deck epic-plan (intent/link/defer/ack).
// Happy paths assert output plus persisted state; failures assert the typed
// message, the exit code, and unchanged state where applicable.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runCli } from '../../src/cli/main.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { epicPlanning, listDependencies } from '../../src/core/board/planning.ts';
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

function groomed(title: string): string {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['do the work'],
    openQuestions: [],
  });
  return item.id;
}

beforeEach(async () => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-cli-plan-');
  registry.register(proj.path);
  store = await openStore(proj.path);
});

afterEach(() => {
  proj.cleanup();
});

describe('deck deps', () => {
  test('list reports no dependencies, then add persists and renders unmet blockers', async () => {
    const card = groomed('wire the planning contracts');
    const prereq = groomed('land the planning engine');
    expect(await run(['deps', card])).toBe(0);
    expect(out[0]).toBe(`card ${card} has no dependencies`);

    expect(await run(['deps', card, 'add', prereq])).toBe(0);
    expect(out[0]).toBe(`deps of ${card}: ${prereq}`);
    expect(listDependencies(store, card)).toEqual([prereq]);

    expect(await run(['deps', card])).toBe(0);
    expect(out.join('\n')).toContain(`card ${card} depends on:`);
    expect(out.join('\n')).toContain('unmet:');
    expect(out.join('\n')).toContain(`  ${prereq} [groomed] land the planning engine`);
  });

  test('remove and set persist the new dependency list', async () => {
    const card = groomed('wire the planning contracts');
    const a = groomed('land the planning engine');
    const b = groomed('ship the planning engine');
    expect(await run(['deps', card, 'set', a, b])).toBe(0);
    expect(out[0]).toBe(`deps of ${card}: ${a}, ${b}`);
    expect(await run(['deps', card, 'remove', a])).toBe(0);
    expect(out[0]).toBe(`deps of ${card}: ${b}`);
    expect(listDependencies(store, card)).toEqual([b]);
    expect(await run(['deps', card, 'set'])).toBe(0);
    expect(listDependencies(store, card)).toEqual([]);
  });

  test('self-dependency is a typed failure and leaves state unchanged', async () => {
    const card = groomed('wire the planning contracts');
    expect(await run(['deps', card, 'add', card])).toBe(1);
    expect(err[0]).toContain('cannot depend on itself');
    expect(listDependencies(store, card)).toEqual([]);
  });

  test('unknown card is a typed not-found failure', async () => {
    expect(await run(['deps', 'nope-0000', 'add', 'other-0000'])).toBe(1);
    expect(err[0]).toContain('not found');
  });

  test('stale --expect-rev refuses the write', async () => {
    const card = groomed('wire the planning contracts');
    const prereq = groomed('land the planning engine');
    expect(await run(['deps', card, 'add', prereq, '--expect-rev', '99'])).toBe(1);
    expect(err[0]).toContain('dependencies of');
    expect(listDependencies(store, card)).toEqual([]);
  });

  test('missing prereq id is a usage error (exit 64)', async () => {
    const card = groomed('wire the planning contracts');
    expect(await run(['deps', card, 'add'])).toBe(64);
    expect(err[0]).toContain('usage: deck deps');
    expect(await run(['deps'])).toBe(64);
  });
});

describe('deck epic-plan', () => {
  test('intent records and persists; the epic read shows it', async () => {
    const epic = store.addEpic('planning epic');
    expect(
      await run(['epic-plan', epic.id, 'intent', 'cover the planning commands', '--criterion', 'deps contract']),
    ).toBe(0);
    expect(out[0]).toContain(`epic ${epic.id} intent recorded — rev 1, 1 criteria`);
    expect(epicPlanning(store, epic.id).intent).toBe('cover the planning commands');

    expect(await run(['epic', epic.id])).toBe(0);
    expect(out.join('\n')).toContain('cover the planning commands');
  });

  test('link connects a criterion to a story of the same epic', async () => {
    const epic = store.addEpic('planning epic');
    await run(['epic-plan', epic.id, 'intent', 'cover the planning commands', '--criterion', 'deps contract']);
    const criterionId = epicPlanning(store, epic.id).criteria[0]!.id;
    const story = store.addNote('land the planning engine');
    store.setEpic(story.id, epic.id);
    const child = convertToVerbItem(store, {
      noteId: story.id,
      proposedVerb: 'feat',
      refinedTitle: 'land the planning engine',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['do the work'],
      openQuestions: [],
    });
    expect(await run(['epic-plan', epic.id, 'link', criterionId, child.id])).toBe(0);
    expect(out[0]).toBe(`criterion ${criterionId} covered by ${child.id}`);
    expect(epicPlanning(store, epic.id).criteria[0]!.coveredBy).toContain(child.id);
  });

  test('defer records the reason; ack on an unattached child is a typed failure', async () => {
    const epic = store.addEpic('planning epic');
    await run(['epic-plan', epic.id, 'intent', 'cover the planning commands', '--criterion', 'deps contract']);
    const criterionId = epicPlanning(store, epic.id).criteria[0]!.id;
    expect(await run(['epic-plan', epic.id, 'defer', criterionId, '--reason', 'waiting on the engine'])).toBe(0);
    expect(out[0]).toContain(`criterion ${criterionId} deferred — waiting on the engine`);

    expect(await run(['epic-plan', epic.id, 'ack', 'nope-0000'])).toBe(1);
    expect(err[0]).toContain('is not attached to an epic');
  });

  test('unknown epic and missing subcommand are typed/usage failures', async () => {
    expect(await run(['epic-plan', 'nope-0000', 'intent', 'text'])).toBe(1);
    expect(err[0]).toContain('not found');
    expect(await run(['epic-plan'])).toBe(64);
    expect(err[0]).toContain('usage: deck epic-plan');
    expect(await run(['epic-plan', 'x', 'intent'])).toBe(64);
  });
});

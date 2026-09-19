import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { deleteCard, updateCard, updateGroom } from '../../../src/core/board/crud.ts';
import { EngineOwnedError, NotFoundError } from '../../../src/core/board/errors.ts';
import { readSince } from '../../../src/core/events/outbox.ts';
import { openStore } from '../../../src/core/board/store.ts';
import type { GroomProposal } from '../../../src/core/board/types.ts';
import { tmpProject, type TmpProject } from '../../helpers.ts';

// v0.2.0 CRUD: rename / hard delete / groom re-edit — manual lanes only,
// events in-transaction, spec files rewritten with preserved checkmarks.

let project: TmpProject | undefined;

afterEach(() => {
  project?.cleanup();
  project = undefined;
});

async function setup(): Promise<ReturnType<typeof openStore>> {
  project = tmpProject('deck-crud-');
  return openStore(project.path);
}

function proposal(overrides: Partial<GroomProposal> = {}): GroomProposal {
  return {
    noteId: 'unused',
    proposedVerb: 'feat',
    refinedTitle: 'engine core',
    research: { codebaseFindings: ['found it'] },
    specDeltas: [{ op: 'ADDED', requirement: 'board ui', text: 'renders five lanes' }],
    tasks: ['implement lanes', 'wire sse'],
    openQuestions: [],
    ...overrides,
  };
}

describe('updateCard', () => {
  test('renames a note in todo and emits card.updated', async () => {
    const store = await setup();
    const note = store.addNote('typo note');
    const updated = updateCard(store, note.id, { title: 'fixed note' });
    expect(updated.title).toBe('fixed note');
    expect(updated.id).toBe(note.id);
    const events = readSince(store.db, 0);
    expect(events.some((event) => event.type === 'card.updated' && event.payload.id === note.id)).toBe(true);
  });

  test('renames a verb item in groomed', async () => {
    const store = await setup();
    const note = store.addNote('to groom');
    convertToVerbItem(store, proposal({ noteId: note.id }));
    const updated = updateCard(store, note.id, { title: 'renamed verb' });
    expect(updated.title).toBe('renamed verb');
    expect('tasks' in updated).toBe(true);
  });

  test('unknown id 404s', async () => {
    const store = await setup();
    expect(() => updateCard(store, 'nope', { title: 'x' })).toThrow(NotFoundError);
  });

  test('engine lane refuses with EngineOwnedError', async () => {
    const store = await setup();
    const note = store.addNote('tweak me');
    // moveLane with source 'engine' is the only path into active for tests
    const { moveLane } = await import('../../../src/core/board/lanes.ts');
    const noteAsVerb = convertToVerbItem(store, proposal({ noteId: note.id }));
    moveLane(store, noteAsVerb.id, 'active', 'engine');
    expect(() => updateCard(store, note.id, { title: 'x' })).toThrow(EngineOwnedError);
  });
});

describe('deleteCard', () => {
  test('hard-deletes a todo note and its event carries lane', async () => {
    const store = await setup();
    const note = store.addNote('delete me');
    deleteCard(store, note.id);
    expect(() => store.getCard(note.id)).toThrow(NotFoundError);
    const events = readSince(store.db, 0);
    const deleted = events.find((event) => event.type === 'card.deleted');
    expect(deleted).toBeDefined();
    expect(deleted!.payload.id).toBe(note.id);
    expect((deleted!.payload as { lane: string }).lane).toBe('todo');
  });

  test('deletes a groomed verb item together with its task rows', async () => {
    const store = await setup();
    const note = store.addNote('groom then delete');
    const item = convertToVerbItem(store, proposal({ noteId: note.id }));
    deleteCard(store, item.id);
    expect(() => store.getCard(item.id)).toThrow(NotFoundError);
    const rows = store.db.select().from(await import('../../../src/core/board/schema.ts').then((m) => m.tasks)).all();
    expect(rows.filter((row) => row.cardId === item.id)).toEqual([]);
  });

  test('unknown id 404s; engine lane refuses', async () => {
    const store = await setup();
    expect(() => deleteCard(store, 'nope')).toThrow(NotFoundError);
    const note = store.addNote('later');
    const item = convertToVerbItem(store, proposal({ noteId: note.id }));
    const { moveLane } = await import('../../../src/core/board/lanes.ts');
    moveLane(store, item.id, 'verify', 'engine');
    expect(() => deleteCard(store, item.id)).toThrow(EngineOwnedError);
  });
});

describe('updateGroom', () => {
  test('revises research/tasks, preserves identity and done-state by id, rewrites spec files', async () => {
    const store = await setup();
    const note = store.addNote('groom target');
    const item = convertToVerbItem(store, proposal({ noteId: note.id }));
    // progress sync addresses the accepted plan ids — the engine list is a
    // progress projection, not an id-replacement door
    store.syncTasks(
      item.id,
      item.tasks.map((task, index) => ({ ...task, done: index === 0 })),
      'engine',
    );
    const [t1, t2] = item.tasks.map((task) => task.id);

    // E03 DECK-ARCH-011: task edits are identity-bearing operations — keep
    // t1, rename t2 in place, add one. Done-state survives by id, not title.
    const revised = updateGroom(store, item.id, {
      ...proposal({
        noteId: item.id,
        proposedVerb: 'fix',
        refinedTitle: 'engine core revised',
        research: { codebaseFindings: ['found it', 'found more'], blastRadius: ['src/ui'], sections: { reproduce: 'steps', rca: 'cause' } },
        tasks: ['implement lanes', 'wire sse better', 'add tests'],
      }),
      taskOps: [
        { op: 'keep', id: t1! },
        { op: 'rename', id: t2!, title: 'wire sse better' },
        { op: 'add', title: 'add tests' },
      ],
    });

    expect(revised.title).toBe('engine core revised');
    expect(revised.verb).toBe('fix');
    expect(revised.research.blastRadius).toEqual(['src/ui']);
    expect(revised.tasks.map((task) => [task.id, task.title, task.done])).toEqual([
      [t1, 'implement lanes', true], // surviving id keeps its done-state
      [t2, 'wire sse better', false], // renamed in place — same identity
      [expect.any(String), 'add tests', false], // added → new id
    ]);
    // specPath never changes, even on a verb change
    expect(revised.specPath).toBe(item.specPath);
    const tasksMd = readFileSync(join(store.projectPath, item.specPath, 'tasks.md'), 'utf-8');
    expect(tasksMd).toContain('- [x] implement lanes');
    expect(tasksMd).toContain('- [ ] wire sse better');
    const specMd = readFileSync(join(store.projectPath, item.specPath, 'spec.md'), 'utf-8');
    // story-first template: no h1 in spec.md (renderCardSpec adds it), the
    // revised research lands as the Research section
    expect(specMd).toContain('## Research');
    expect(specMd).toContain('- found more');
  });

  test('open questions gate an edit — the shared readiness policy (E03)', async () => {
    const store = await setup();
    const note = store.addNote('groom target');
    const item = convertToVerbItem(store, proposal({ noteId: note.id }));
    // DECK-ARCH-008: re-groom applies the same policy as initial groom.
    expect(() =>
      updateGroom(store, item.id, { ...proposal({ noteId: item.id }), openQuestions: ['still open?'] }),
    ).toThrow(/unanswered open questions/);
  });

  test('non-verb card 404s; engine lane refuses', async () => {
    const store = await setup();
    const note = store.addNote('plain note');
    expect(() => updateGroom(store, note.id, proposal({ noteId: note.id }))).toThrow(NotFoundError);
    const groomed = convertToVerbItem(store, proposal({ noteId: store.addNote('x').id }));
    const { moveLane } = await import('../../../src/core/board/lanes.ts');
    moveLane(store, groomed.id, 'active', 'engine');
    expect(() => updateGroom(store, groomed.id, proposal({ noteId: groomed.id }))).toThrow(EngineOwnedError);
  });
});

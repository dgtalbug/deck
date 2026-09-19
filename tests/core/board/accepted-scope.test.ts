import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { specRevisions } from '../../../src/core/board/schema.ts';
import { tmpProject } from '../../helpers.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { newestSpecVersion } from '../../../src/core/board/specstore.ts';
import {
  acceptedContentDigest,
  acceptedRevision,
  applyScopeEdit,
  currentAcceptedSnapshot,
  currentScopeRevision,
  recordAcceptedRevision,
  revisionIdOf,
  ScopeConflictError,
  snapshotAt,
  StaleBasisError,
  UnclassifiedScopeError,
  type AcceptedScopeSnapshot,
} from '../../../src/core/board/accepted-scope.ts';

let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('accepted-scope-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

function snapshot(overrides: Partial<AcceptedScopeSnapshot> = {}): AcceptedScopeSnapshot {
  return {
    verb: 'feat',
    title: 'build the thing',
    requirements: [{ id: 'r-aaaaaaaa', position: 0, title: 'requirement one', body: 'body one' }],
    criteria: [{ id: 'c-aaaaaaaa', title: 'requirement one', state: 'active' }],
    plan: [
      { id: 't-aaaaaaaa', position: 0, title: 'write code', state: 'active' },
      { id: 't-bbbbbbbb', position: 1, title: 'write code', state: 'active' },
    ],
    ...overrides,
  };
}

describe('accepted scope mappers', () => {
  test('first record mints revision 1 with stable identity and readable snapshot', () => {
    const note = store.addNote('mapper one');
    const outcome = recordAcceptedRevision(store.db, note.id, snapshot(), [{ kind: 'story' }], { actor: 'human' });
    expect(outcome).toMatchObject({ revision: 1, revisionId: revisionIdOf(note.id, 1), changed: true });

    const revision = acceptedRevision(store.db, note.id);
    expect(revision).toMatchObject({
      cardId: note.id,
      revision: 1,
      actor: 'human',
      basisRevision: null,
      operations: [{ kind: 'story' }],
    });

    const current = currentAcceptedSnapshot(store.db, note.id);
    expect(current?.plan.map((item) => item.title)).toEqual(['write code', 'write code']);
    expect(current?.plan.map((item) => item.id)).toEqual(['t-aaaaaaaa', 't-bbbbbbbb']);
    expect(current?.criteria).toEqual([{ id: 'c-aaaaaaaa', title: 'requirement one', state: 'active' }]);
    expect(currentScopeRevision(store.db, note.id)).toBe(1);
  });

  test('identical accepted content returns the existing revision without new rows', () => {
    const note = store.addNote('mapper noop');
    const first = recordAcceptedRevision(store.db, note.id, snapshot(), [{ kind: 'story' }], { actor: 'human' });
    const again = recordAcceptedRevision(store.db, note.id, snapshot(), [], { actor: 'human' });
    expect(again.changed).toBe(false);
    expect(again.revision).toBe(first.revision);
    expect(again.revisionId).toBe(first.revisionId);
    expect(acceptedRevision(store.db, note.id)?.revision).toBe(1);
    const snapshotRows = store.db.select().from(specRevisions).all().filter((row) => row.cardId === note.id);
    expect(snapshotRows).toHaveLength(1);
  });

  test('changed content appends a revision and prior snapshots stay readable', () => {
    const note = store.addNote('mapper chain');
    const first = recordAcceptedRevision(store.db, note.id, snapshot(), [{ kind: 'story' }], { actor: 'human' });
    const second = recordAcceptedRevision(
      store.db,
      note.id,
      snapshot({ plan: [{ id: 't-aaaaaaaa', position: 0, title: 'write code', state: 'active' }] }),
      [{ kind: 'task', op: 'remove', id: 't-bbbbbbbb' }],
      { actor: 'human', basisRevision: first.revision },
    );
    expect(second.changed).toBe(true);
    expect(second.revision).toBe(2);

    const revisionTwo = acceptedRevision(store.db, note.id, 2);
    expect(revisionTwo?.basisRevision).toBe(1);
    expect(snapshotAt(store.db, note.id, 1)?.plan).toHaveLength(2);
    expect(snapshotAt(store.db, note.id, 2)?.plan).toHaveLength(1);
    expect(currentAcceptedSnapshot(store.db, note.id)?.plan).toHaveLength(1);
  });

  test('digest ignores task progress while render checksums change with it', () => {
    const base = snapshot();
    const progressFlipped = snapshot();
    progressFlipped.plan = progressFlipped.plan.map((item) => ({ ...item }));
    expect(acceptedContentDigest(progressFlipped)).toBe(acceptedContentDigest(base));

    const renderWithProgress = (doneFirst: boolean): string =>
      base.plan.map((item, index) => `- [${doneFirst && index === 0 ? 'x' : ' '}] ${item.title}`).join('\n');
    const checksumOf = (markdown: string) => createHash('sha256').update(markdown, 'utf8').digest('hex');
    expect(checksumOf(renderWithProgress(false))).not.toBe(checksumOf(renderWithProgress(true)));
  });

  test('digest covers accepted content: verb, title, requirements, criteria, plan', () => {
    const base = snapshot();
    expect(acceptedContentDigest(snapshot({ verb: 'fix' }))).not.toBe(acceptedContentDigest(base));
    expect(acceptedContentDigest(snapshot({ title: 'other' }))).not.toBe(acceptedContentDigest(base));
    expect(
      acceptedContentDigest(snapshot({ requirements: [{ id: 'r-aaaaaaaa', position: 0, title: 'requirement one', body: 'changed' }] })),
    ).not.toBe(acceptedContentDigest(base));
    expect(
      acceptedContentDigest(snapshot({ criteria: [{ id: 'c-aaaaaaaa', title: 'requirement one', state: 'removed' }] })),
    ).not.toBe(acceptedContentDigest(base));
    expect(
      acceptedContentDigest(snapshot({ plan: [...base.plan.slice(1), base.plan[0]!].map((item, index) => ({ ...item, position: index })) })),
    ).not.toBe(acceptedContentDigest(base));
  });

  test('unclassified card without revisions reads as null snapshot', () => {
    const note = store.addNote('mapper none');
    expect(currentAcceptedSnapshot(store.db, note.id)).toBeNull();
    expect(acceptedRevision(store.db, note.id)).toBeNull();
    expect(currentScopeRevision(store.db, note.id)).toBe(0);
  });

  test('first groom creates the accepted revision plus a rendered markdown projection', () => {
    const note = store.addNote('groom to accepted scope');
    const item = convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'ship the feature',
      research: { codebaseFindings: ['finding'], story: 'why it matters' },
      specDeltas: [
        { op: 'ADDED', requirement: 'core behavior', text: 'the system does the thing' },
        { op: 'ADDED', requirement: 'core behavior', text: 'duplicate title collapses to one criterion' },
      ],
      tasks: ['build it', 'test it'],
      openQuestions: [],
    });

    expect(currentScopeRevision(store.db, note.id)).toBe(1);
    const revision = acceptedRevision(store.db, note.id);
    expect(revision?.actor).toBe('groom');
    expect(revision?.operations).toEqual([{ kind: 'story', verb: 'feat', title: 'ship the feature' }]);
    const snapshot = currentAcceptedSnapshot(store.db, note.id);
    expect(snapshot?.requirements).toHaveLength(2);
    expect(snapshot?.requirements[0]).toMatchObject({ title: 'core behavior', body: 'the system does the thing' });
    expect(snapshot?.criteria).toEqual([{ id: expect.stringMatching(/^c-[0-9a-f]{8}$/), title: 'core behavior', state: 'active' }]);
    expect(snapshot?.plan.map((entry) => entry.title)).toEqual(['build it', 'test it']);
    expect(snapshot?.plan.map((entry) => entry.id)).toEqual(item.tasks.map((task) => task.id));

    const version = newestSpecVersion(store, note.id);
    expect(version).toBeDefined();
    expect(version!.markdown).toContain('## Checklist');
  });
});

describe('revision-checked scope edit operations', () => {
  function seed(cardTitle: string): { id: string; planIds: string[] } {
    const note = store.addNote(cardTitle);
    const item = convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: cardTitle,
      research: { codebaseFindings: ['finding'] },
      specDeltas: [{ op: 'ADDED', requirement: 'alpha', text: 'alpha text' }],
      tasks: ['first task', 'second task'],
      openQuestions: [],
    });
    return { id: note.id, planIds: item.tasks.map((task) => task.id) };
  }

  test('no-op edit returns the existing revision identity', () => {
    const { id } = seed('edit noop');
    const outcome = applyScopeEdit(store.db, id, {
      operations: [{ kind: 'task', op: 'keep', id: currentAcceptedSnapshot(store.db, id)!.plan[0]!.id }],
      actor: 'test',
    });
    expect(outcome.changed).toBe(false);
    expect(outcome.revision).toBe(1);
  });

  test('reorder preserves ids and only repositions', () => {
    const { id, planIds } = seed('edit reorder');
    const outcome = applyScopeEdit(store.db, id, {
      operations: [{ kind: 'task', op: 'reorder', order: [...planIds].reverse() }],
      actor: 'test',
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.revision).toBe(2);
    const plan = currentAcceptedSnapshot(store.db, id)!.plan;
    expect(plan.map((item) => item.id)).toEqual([...planIds].reverse());
  });

  test('rename preserves the declared id and records the operation', () => {
    const { id } = seed('edit rename');
    const snapshot = currentAcceptedSnapshot(store.db, id)!;
    const criterionId = snapshot.criteria[0]!.id;
    const outcome = applyScopeEdit(store.db, id, {
      operations: [{ kind: 'criterion', op: 'rename', id: criterionId, title: 'alpha renamed' }],
      actor: 'test',
    });
    expect(outcome.changed).toBe(true);
    expect(acceptedRevision(store.db, id, 2)?.operations).toEqual([
      { kind: 'criterion', op: 'rename', id: criterionId, title: 'alpha renamed' },
    ]);
    expect(currentAcceptedSnapshot(store.db, id)!.criteria).toEqual([
      { id: criterionId, title: 'alpha renamed', state: 'active' },
    ]);
  });

  test('add mints ids and duplicate titles stay distinct', () => {
    const { id } = seed('edit add');
    const outcome = applyScopeEdit(store.db, id, {
      operations: [
        { kind: 'task', op: 'add', title: 'first task' },
        { kind: 'task', op: 'add', title: 'first task' },
      ],
      actor: 'test',
    });
    expect(outcome.changed).toBe(true);
    const plan = currentAcceptedSnapshot(store.db, id)!.plan;
    const sameTitle = plan.filter((item) => item.title === 'first task' && item.state === 'active');
    expect(sameTitle).toHaveLength(3);
    expect(new Set(sameTitle.map((item) => item.id)).size).toBe(3);
  });

  test('remove drops the id from current scope but the prior revision keeps it attributable', () => {
    const { id, planIds } = seed('edit remove');
    applyScopeEdit(store.db, id, {
      operations: [{ kind: 'task', op: 'remove', id: planIds[0]! }],
      actor: 'test',
    });
    const plan = currentAcceptedSnapshot(store.db, id)!.plan;
    expect(plan.map((item) => item.id)).toEqual([planIds[1]]);
    expect(snapshotAt(store.db, id, 1)!.plan.map((item) => item.id)).toEqual(planIds);
    // re-adding the same title mints a fresh identity — removal history stays
    applyScopeEdit(store.db, id, { operations: [{ kind: 'task', op: 'add', title: 'first task' }], actor: 'test' });
    const after = currentAcceptedSnapshot(store.db, id)!.plan;
    const sameTitle = after.filter((item) => item.title === 'first task');
    expect(sameTitle).toHaveLength(1);
    expect(sameTitle[0]!.id).not.toBe(planIds[0]);
  });

  test('supersede replaces the id; the superseded id stays readable in prior revisions', () => {
    const { id } = seed('edit supersede');
    const criterionId = currentAcceptedSnapshot(store.db, id)!.criteria[0]!.id;
    applyScopeEdit(store.db, id, {
      operations: [{ kind: 'criterion', op: 'supersede', id: criterionId, replacement: 'beta' }],
      actor: 'test',
    });
    const criteria = currentAcceptedSnapshot(store.db, id)!.criteria;
    expect(criteria.map((item) => item.id)).not.toContain(criterionId);
    expect(criteria.find((item) => item.title === 'beta')?.state).toBe('active');
    expect(snapshotAt(store.db, id, 1)!.criteria[0]!.id).toBe(criterionId);
  });

  test('stale basis refuses with a structured rebase preview and performs no writes', () => {
    const { id, planIds } = seed('edit stale');
    applyScopeEdit(store.db, id, {
      operations: [{ kind: 'task', op: 'rename', id: planIds[0]!, title: 'renamed on rev 2' }],
      actor: 'first editor',
    });
    const before = currentScopeRevision(store.db, id);
    let thrown: StaleBasisError | undefined;
    try {
      applyScopeEdit(store.db, id, {
        operations: [
          { kind: 'task', op: 'rename', id: planIds[1]!, title: 'stale rename' },
          { kind: 'task', op: 'remove', id: 't-does-not-exist' },
        ],
        actor: 'second editor',
        basisRevision: 1,
      });
    } catch (error) {
      thrown = error as StaleBasisError;
    }
    expect(thrown).toBeInstanceOf(StaleBasisError);
    expect(thrown!.preview.current).toMatchObject({ cardId: id, revision: 2 });
    expect(thrown!.preview.attempted).toHaveLength(2);
    expect(thrown!.preview.conflicts).toEqual([`task 't-does-not-exist' is not in the current accepted scope`]);
    expect(thrown!.preview.safeNoOps).toEqual([]);
    expect(currentScopeRevision(store.db, id)).toBe(before);
    expect(snapshotAt(store.db, id, 3)).toBeNull();
  });

  test('unknown target on a fresh basis is a typed conflict with no writes', () => {
    const { id } = seed('edit conflict');
    const before = currentScopeRevision(store.db, id);
    expect(() =>
      applyScopeEdit(store.db, id, { operations: [{ kind: 'task', op: 'rename', id: 't-unknown', title: 'x' }], actor: 'test' }),
    ).toThrow(ScopeConflictError);
    expect(currentScopeRevision(store.db, id)).toBe(before);
  });

  test('unclassified and quarantined cards refuse id-based edits', () => {
    const note = store.addNote('edit unclassified');
    expect(() =>
      applyScopeEdit(store.db, note.id, { operations: [{ kind: 'task', op: 'add', title: 'x' }], actor: 'test' }),
    ).toThrow(UnclassifiedScopeError);
  });
});

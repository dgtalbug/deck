import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { updateGroom } from '../../../src/core/board/crud.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { specs } from '../../../src/core/board/specstore.ts';
import { tmpProject } from '../../helpers.ts';

// Task 2.4 — version law: groom accept records v1, re-edit appends,
// identical checksum does not duplicate.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-spec-versions-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

function proposal(noteId: string, title = 'refined: fix the thing') {
  return {
    noteId,
    proposedVerb: 'fix' as const,
    refinedTitle: title,
    research: { codebaseFindings: ['evidence'], sections: { reproduce: 'steps', rca: 'cause' } },
    specDeltas: [{ op: 'ADDED' as const, requirement: 'req', text: 'text' }],
    tasks: ['investigate'],
    openQuestions: [],
  };
}

describe('spec versions', () => {
  test('groom accept records version 1', () => {
    const note = store.addNote('fix the thing');
    convertToVerbItem(store, proposal(note.id));
    const versions = specs(store, note.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.markdown).toContain('# fix: refined: fix the thing');
    expect(versions[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test('re-edit appends a version', () => {
    const note = store.addNote('versioned change');
    convertToVerbItem(store, proposal(note.id));
    updateGroom(store, note.id, proposal(note.id, 'refined: now different'));
    const versions = specs(store, note.id);
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
  });

  test('identical content does not duplicate', () => {
    const note = store.addNote('stable change');
    const item = convertToVerbItem(store, proposal(note.id));
    updateGroom(store, note.id, proposal(note.id, item.title));
    const versions = specs(store, note.id);
    expect(versions).toHaveLength(1);
  });

  test('versions list newest-first', () => {
    const note = store.addNote('ordering check');
    convertToVerbItem(store, proposal(note.id));
    updateGroom(store, note.id, proposal(note.id, 'refined: second'));
    updateGroom(store, note.id, proposal(note.id, 'refined: third'));
    const versions = specs(store, note.id);
    expect(versions.map((version) => version.version)).toEqual([3, 2, 1]);
  });
});

// --- E03: scope revisions vs render checksums (DECK-ARCH-011, follow-up 6.4) --
import { newestSpecVersion, recordSpecVersion, renderCardSpec } from '../../../src/core/board/specstore.ts';
import { currentScopeRevision, recordScopeRevision, scopeCriteria } from '../../../src/core/board/scope.ts';
import { scopeRevisions } from '../../../src/core/board/schema.ts';
import { eq } from 'drizzle-orm';

describe('E03 scope revision lineage', () => {
  test('checkbox-only progress changes the render checksum, never scope identity', async () => {
    const note = store.addNote('divergence probe');
    const item = convertToVerbItem(store, proposal(note.id));
    const scopeBefore = currentScopeRevision(store.db, item.id);
    const firstRender = recordSpecVersion(store, item.id, renderCardSpec(store, store.getVerbItem(item.id)));
    store.syncTasks(
      item.id,
      store.getVerbItem(item.id).tasks.map((task, index) => ({ ...task, done: index === 0 })),
      'engine',
    );
    const secondRender = recordSpecVersion(store, item.id, renderCardSpec(store, store.getVerbItem(item.id)));
    expect(secondRender.checksum).not.toBe(firstRender.checksum); // publication identity moved
    expect(secondRender.version).toBe(firstRender.version + 1);
    expect(currentScopeRevision(store.db, item.id)).toBe(scopeBefore); // scope identity fixed
    // the recorded scope revision's digest excludes checkbox state: re-recording
    // the current scope changes nothing
    const before = currentScopeRevision(store.db, item.id);
    const itemNow = store.getVerbItem(item.id);
    const { changed } = recordScopeRevision(
      store.db,
      item.id,
      {
        verb: itemNow.verb,
        title: itemNow.title,
        tasks: itemNow.tasks.map((task) => ({ id: task.id, title: task.title })),
        criteria: scopeCriteria(store.db, item.id).map((criterion) => ({ ...criterion })),
      },
      ['no-op'],
    );
    expect(changed).toBe(false);
    expect(currentScopeRevision(store.db, item.id)).toBe(before);
  });

  test('every accepted scope change leaves a readable immutable revision row', () => {
    const note = store.addNote('lineage probe');
    const item = convertToVerbItem(store, proposal(note.id));
    const ids = item.tasks.map((task) => task.id);
    updateGroom(store, item.id, {
      ...proposal(item.id, 'lineage probe v2'),
      taskOps: [...ids.map((id) => ({ op: 'keep' as const, id })), { op: 'add' as const, title: 'extra scope' }],
      tasks: ['investigate', 'fix it', 'extra scope'],
    });
    const rows = store.db.select().from(scopeRevisions).where(eq(scopeRevisions.cardId, item.id)).all();
    expect(rows.length).toBe(2);
    expect(rows[0]!.revision).toBe(1);
    expect(rows[1]!.revision).toBe(2);
    expect(JSON.parse(rows[0]!.operations as string)).toEqual([
      { kind: 'story', verb: 'fix', title: 'refined: fix the thing' },
    ]);
    // the render checksum is a publication identity — never labeled a scope revision
    const newest = newestSpecVersion(store, item.id);
    expect(newest?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(newest?.checksum).not.toBe(rows[1]!.digest);
  });

  test('failed spec materialization after a committed groom recovers on the next edit (6.4)', () => {
    const note = store.addNote('materialization recovery probe');
    const item = convertToVerbItem(store, proposal(note.id));
    // the db scope state is already committed; a file-level failure (deleted
    // spec dir) must not wedge the identity ledger
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(`${store.projectPath}/${item.specPath}`, { recursive: true, force: true });
    const revision = currentScopeRevision(store.db, item.id);
    const ids = item.tasks.map((task) => task.id);
    const recovered = updateGroom(store, item.id, {
      ...proposal(item.id),
      taskOps: ids.map((id) => ({ op: 'keep' as const, id })),
      tasks: item.tasks.map((task) => task.title),
    });
    expect(recovered.tasks).toHaveLength(item.tasks.length);
    expect(currentScopeRevision(store.db, item.id)).toBe(revision); // identical scope: no new revision
    expect(newestSpecVersion(store, item.id)).toBeDefined(); // files re-materialized
  });
});

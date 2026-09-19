import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { tmpProject } from '../../helpers.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { updateGroom } from '../../../src/core/board/crud.ts';
import {
  acceptedRevision,
  currentScopeRevision,
  scopeClassification,
} from '../../../src/core/board/accepted-scope.ts';
import {
  issueDrift,
  markdownDrift,
  newestSpecVersion,
  setIssueMap,
} from '../../../src/core/board/specstore.ts';
import { nextDigest } from '../../../src/core/board/next.ts';
import { criterionTextDigest } from '../../../src/core/board/capability-deltas.ts';
import {
  currentCapabilityStatements,
} from '../../../src/core/board/capability-projection.ts';
import { runCli } from '../../../src/cli/main.ts';
import { ProjectRegistry } from '../../../src/core/projects/registry.ts';
import type { TmpProject } from '../../helpers.ts';

let store: DocumentStore;
let project: TmpProject;
let registry: ProjectRegistry;
let out: string[] = [];
let err: string[] = [];
const io = { out: (text: string) => out.push(text), err: (text: string) => err.push(text) };

beforeAll(async () => {
  project = tmpProject('projection-conformance-');
  registry = new ProjectRegistry();
  registry.register(project.path);
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

function groomed(cardTitle: string, requirement: string): string {
  const note = store.addNote(cardTitle);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: cardTitle,
    research: { codebaseFindings: ['finding'] },
    specDeltas: [{ op: 'ADDED', requirement, text: 'requirement body' }],
    tasks: ['build it', 'test it'],
    openQuestions: [],
  });
  return item.id;
}

describe('cross-projection conformance', () => {
  test('board, markdown, digest, issue and capability projections agree on the accepted revision', async () => {
    const cardId = groomed('conformance story', 'conformance criterion');
    const revision = acceptedRevision(store.db, cardId)!;
    expect(revision.revision).toBe(1);

    // progress does not move accepted identity; the render records the same revision
    store.syncTasks(cardId, store.getVerbItem(cardId).tasks.map((task, index) => ({ ...task, done: index === 0 })), 'engine');
    const newest = newestSpecVersion(store, cardId)!;
    expect(newest.scopeRevision).toBe(1);
    expect(currentScopeRevision(store.db, cardId)).toBe(1);

    // an accepted scope edit appends revision 2 and re-renders
    const ids = store.getVerbItem(cardId).tasks.map((task) => task.id);
    updateGroom(store, cardId, {
      noteId: cardId,
      proposedVerb: 'feat',
      refinedTitle: 'conformance story',
      research: { codebaseFindings: ['finding'] },
      specDeltas: [{ op: 'ADDED', requirement: 'conformance criterion', text: 'requirement body' }],
      tasks: ['build it', 'test it', 'harden it'],
      openQuestions: [],
      taskOps: [
        { op: 'keep', id: ids[0]! },
        { op: 'keep', id: ids[1]! },
        { op: 'add', title: 'harden it' },
      ],
    });
    expect(currentScopeRevision(store.db, cardId)).toBe(2);
    expect(scopeClassification(store.db, cardId)).toBe('accepted');

    // markdown projection names revision 2 after the edit's re-render
    const rendered = newestSpecVersion(store, cardId)!;
    expect(rendered.scopeRevision).toBe(2);
    expect(markdownDrift(store, cardId)).toBeNull();

    // issue projection: publishing links the issue body to the same revision
    setIssueMap(store, {
      cardId,
      issueNumber: 42,
      state: 'open',
      checksum: rendered.checksum,
      scopeRevision: rendered.scopeRevision,
    });
    expect(issueDrift(store, cardId)).toBeNull();

    // next digest names the accepted revision and separates checksum/progress
    const digest = nextDigest(store);
    expect(digest.cardId).toBe(cardId);
    const revisionTwo = acceptedRevision(store.db, cardId, 2)!;
    expect(digest.context).toContain(`scope: accepted revision 2 (${revisionTwo.revisionId})`);
    expect(digest.context).toContain('publication identity, not scope');
    expect(digest.context).toContain('mutable progress, not scope');

    // capability delta cites revision 2 and stores the same lineage
    const snapshot = store.getVerbItem(cardId);
    void snapshot;
    const criterion = (await import('../../../src/core/board/accepted-scope.ts')).currentAcceptedSnapshot(store.db, cardId)!.criteria[0]!;
    const deltaFile = join(project.path, 'cap.json');
    await Bun.write(deltaFile, JSON.stringify({
      batchId: 'batch:conformance',
      deltas: [{
        op: 'add',
        deltaId: 'delta:conformance',
        capabilityId: 'capability:conformance',
        statementId: 'statement:one',
        statementText: criterion.title,
        source: {
          cardId,
          criterionId: criterion.id,
          scopeRevision: 2,
          criterionDigest: criterionTextDigest(criterion.title),
          evidenceId: 'evidence:ev-conf',
          deliveryId: 'delivery:dl-conf',
        },
      }],
      sources: [{ cardId, criterionId: criterion.id, scopeRevision: 2, criterionText: criterion.title }],
      eligibility: [{
        deltaId: 'delta:conformance',
        status: 'eligible',
        assurance: 'local',
        evidenceId: 'evidence:ev-conf',
        deliveryId: 'delivery:dl-conf',
        reasons: [],
        sourceDrift: 'none',
      }],
    }));
    out = [];
    err = [];
    expect(await runCli(['capability', 'preview', deltaFile], { registry, cwd: project.path, io })).toBe(0);
    const preview = JSON.parse(out.join('\n')) as { previewId: string };
    out = [];
    expect(await runCli(['capability', 'apply', preview.previewId, '--accept', '--by', 'conformance'], { registry, cwd: project.path, io })).toBe(0);
    const statement = currentCapabilityStatements(store)[0]!;
    expect(statement.sourceCardId).toBe(cardId);
    expect(statement.sourceScopeRevision).toBe(2);

    // every projection names the same current revision
    const currentRevision = currentScopeRevision(store.db, cardId);
    expect(newestSpecVersion(store, cardId)!.scopeRevision).toBe(currentRevision);
    expect(markdownDrift(store, cardId)).toBeNull();
    expect(issueDrift(store, cardId)).toBeNull();
  });

  test('drift diagnostics name the stale and current revisions without acting as truth', () => {
    const cardId = groomed('drift story', 'drift criterion');
    // simulate a stored projection left behind by a scope edit
    const rendered = newestSpecVersion(store, cardId)!;
    setIssueMap(store, { cardId, issueNumber: 7, state: 'open', checksum: rendered.checksum, scopeRevision: 1 });
    const ids = store.getVerbItem(cardId).tasks.map((task) => task.id);
    updateGroom(store, cardId, {
      noteId: cardId,
      proposedVerb: 'feat',
      refinedTitle: 'drift story',
      research: { codebaseFindings: ['finding'] },
      specDeltas: [{ op: 'ADDED', requirement: 'drift criterion', text: 'requirement body' }],
      tasks: ['only task'],
      openQuestions: [],
      taskOps: [{ op: 'remove', id: ids[1]! }, { op: 'keep', id: ids[0]! }],
    });
    // markdown re-rendered by the edit; the issue still projects revision 1
    expect(markdownDrift(store, cardId)).toBeNull();
    const drift = issueDrift(store, cardId)!;
    expect(drift).toMatchObject({ projection: 'issue', staleRevision: 1, currentRevision: 2 });
    expect(drift.action).toContain('publish the card again');
  });
});

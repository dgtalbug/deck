// Completion bundles: the lifecycle extension reconstructs requirement-to-
// completion lineage from a clean clone and records omissions instead of raw
// sensitive content.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { tmpProject } from '../../helpers.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { enrollPolicy, getPolicy } from '../../../src/core/board/rules.ts';
import { scopeCriteria } from '../../../src/core/board/accepted-scope.ts';
import {
  beginEvidenceRun,
  completeEvidenceRun,
  recordCheckpoint,
  recordCompletion,
  startApply,
} from '../../../src/core/engine/apply.ts';
import { captureExecutionInputs } from '../../../src/core/engine/evidence-inputs.ts';
import { collectEvidenceBundleSnapshot } from '../../../src/core/board/evidence-bundle.ts';
import { parseEvidenceBundle, type EvidenceBundle } from '../../../src/core/board/evidence-bundle-schema.ts';

let store: DocumentStore;
let cleanup: () => void;

beforeEach(async () => {
  const project = tmpProject('deck-completion-bundle-');
  cleanup = project.cleanup;
  const git = (command: string): string => execSync(`git ${command}`, { cwd: project.path, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(project.path, '.gitignore'), '.deck/\n');
  writeFileSync(join(project.path, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m "c1"');
  store = await openStore(project.path);
});

afterEach(() => {
  cleanup();
});

interface LifecycleStory {
  cardId: string;
  impactBasis: { classification: string; snapshotId: string | null; approved: boolean };
  applyOperations: Array<{ id: string; acceptedRevision: number; state: string }>;
  checkpoints: Array<{ id: string; checkpointRevision: number; digest: string; projection: string }>;
  evidenceRuns: Array<{ id: string; state: string; result: string; links: Array<{ criterionId: string | null }> }>;
  completion: {
    id: string;
    acceptedRevision: number;
    inputFingerprint: string;
    deliveryProvenance: string | null;
    uncertainty: string[];
  } | null;
}

function lifecycleOf(bundle: EvidenceBundle): { schema: string; stories: LifecycleStory[] } {
  return (bundle.extensions as Record<string, unknown>)['deck/lifecycle'] as { schema: string; stories: LifecycleStory[] };
}

describe('completion bundle', () => {
  test('a completed card exports reconstructable lineage with recorded omissions', async () => {
    const epic = store.addEpic('portable completion');
    const note = store.addNote('completed story');
    store.setEpic(note.id, epic.id);
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'completed story',
      research: { codebaseFindings: [] },
      specDeltas: [{ op: 'ADDED', requirement: 'The feature SHALL work', text: 'body' }],
      tasks: ['the only task'],
      openQuestions: [],
    });
    const id = note.id;
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    enrollPolicy(store, id, { mode: 'solo' });
    await startApply(store, id);
    recordCheckpoint(store, { cardId: id, kind: 'decision', text: 'design decided thusly', actor: 'agent' });
    const criteria = scopeCriteria(store.db, id).filter((c) => c.state === 'active').map((c) => c.id);
    const fingerprint = (await captureExecutionInputs(store.projectPath, { declaredInputs: [] })).fingerprint;
    const run = beginEvidenceRun(store, {
      cardId: id,
      producer: 'suite',
      checkType: 'machine',
      inputFingerprint: fingerprint,
      policyVersion: getPolicy(store, id)!.version,
    });
    completeEvidenceRun(store, { runId: run.id, result: 'passed', criteria });
    const completion = await recordCompletion(store, { cardId: id, deliveryId: 'dl-local', deliveryProvenance: 'local' });

    const bundle = collectEvidenceBundleSnapshot(store, epic.id);
    const parsed = parseEvidenceBundle(JSON.parse(JSON.stringify(bundle)));
    expect(parsed.unsupportedRootFields).toEqual([]);
    const lifecycle = lifecycleOf(parsed.bundle);
    expect(lifecycle.schema).toBe('deck.lifecycle/1');
    const story = lifecycle.stories.find((entry) => entry.cardId === id)!;

    // Requirement-to-completion lineage: criterion → run → completion.
    expect(story.impactBasis.classification).toBe('missing');
    expect(story.applyOperations).toHaveLength(1);
    expect(story.applyOperations[0]!.state).toBe('completed');
    expect(story.checkpoints[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
    const linked = story.evidenceRuns.find((entry) => entry.links.some((link) => link.criterionId === criteria[0]))!;
    expect(linked.result).toBe('passed');
    expect(story.completion!.id).toBe(completion.id);
    expect(story.completion!.inputFingerprint).toBe(fingerprint);
    expect(story.completion!.deliveryProvenance).toBe('local');
    expect(story.completion!.uncertainty).toContain('no approved impact snapshot — blast radius is not graph-backed');

    // Sensitive and machine-local content is omitted by name, never embedded.
    const omissionFields = parsed.bundle.omissions.map((omission) => `${omission.field}:${omission.reason}`);
    expect(omissionFields).toContain(`lifecycle.${id}.checkpoints:checkpoint-body`);
    expect(omissionFields).toContain(`lifecycle.${id}.apply.checkout:absolute-path`);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('design decided thusly');
  });

  test('an incomplete card carries uncertainty and a null completion instead of partial proof', () => {
    const epic = store.addEpic('incomplete epic');
    const note = store.addNote('unfinished story');
    store.setEpic(note.id, epic.id);
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'unfinished story',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['a task'],
      openQuestions: [],
    });
    const bundle = collectEvidenceBundleSnapshot(store, epic.id);
    const story = lifecycleOf(bundle).stories.find((entry) => entry.cardId === note.id)!;
    expect(story.completion).toBeNull();
    expect(story.evidenceRuns).toEqual([]);
  });
});

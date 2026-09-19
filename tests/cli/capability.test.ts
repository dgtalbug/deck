import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { criterionTextDigest, type CapabilityDeltaSource } from '../../src/core/board/capability-deltas.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { currentAcceptedSnapshot } from '../../src/core/board/accepted-scope.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

let registry: ProjectRegistry;
let proj: TmpProject;
let store: DocumentStore;
let out: string[];
let err: string[];
const io = { out: (text: string) => out.push(text), err: (text: string) => err.push(text) };

async function run(argv: string[]): Promise<number> {
  out = [];
  err = [];
  return runCli(argv, { registry, cwd: proj.path, io });
}

interface RealSource {
  cardId: string;
  criterionId: string;
  scopeRevision: number;
  criterionText: string;
}

// Capability sources must cite the exact accepted revision a groom created:
// the criterion is the delta requirement title under its deterministic id.
function groomRealSource(title: string): RealSource {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: ['finding'] },
    specDeltas: [{ op: 'ADDED', requirement: title, text: 'requirement body' }],
    tasks: ['build it'],
    openQuestions: [],
  });
  const snapshot = currentAcceptedSnapshot(store.db, item.id)!;
  const criterion = snapshot.criteria.find((entry) => entry.state === 'active')!;
  return { cardId: item.id, criterionId: criterion.id, scopeRevision: 1, criterionText: criterion.title };
}

async function writeDeltaFile(name: string, source: RealSource, batchId: string, deltaId: string): Promise<string> {
  const path = join(proj.path, name);
  const declared: CapabilityDeltaSource = {
    cardId: source.cardId,
    criterionId: source.criterionId,
    scopeRevision: source.scopeRevision,
    criterionText: source.criterionText,
  };
  await Bun.write(path, JSON.stringify({
    batchId,
    deltas: [{
      op: 'add',
      deltaId,
      capabilityId: 'capability:evidence',
      statementId: 'statement:lineage',
      statementText: source.criterionText,
      source: {
        cardId: declared.cardId,
        criterionId: declared.criterionId,
        scopeRevision: declared.scopeRevision,
        criterionDigest: criterionTextDigest(declared.criterionText),
        evidenceId: 'evidence:ev-1',
        deliveryId: 'delivery:dl-1',
      },
    }],
    sources: [declared],
    eligibility: [{
      deltaId,
      status: 'eligible',
      assurance: 'local',
      evidenceId: 'evidence:ev-1',
      deliveryId: 'delivery:dl-1',
      reasons: [],
      sourceDrift: 'none',
    }],
  }));
  return path;
}

beforeEach(async () => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-capability-cli-');
  registry.register(proj.path);
  store = await openStore(proj.path);
});

afterEach(() => {
  proj.cleanup();
});

describe('capability command', () => {
  test('previews and explicitly applies a local capability delta', async () => {
    const source = groomRealSource('Evidence bundles preserve lineage');
    const path = await writeDeltaFile('delta.json', source, 'batch:cli', 'delta:cli');

    expect(await run(['capability', 'preview', path])).toBe(0);
    const preview = JSON.parse(out.join('\n')) as { previewId: string; state: string };
    expect(preview.state).toBe('previewed');

    expect(await run(['capability', 'apply', preview.previewId])).toBe(64);
    expect(err.join('\n')).toContain('--accept');

    expect(await run(['capability', 'apply', preview.previewId, '--accept', '--by', 'reviewer'])).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ version: 1, reused: false });
    expect(store.db.all('SELECT text FROM capability_statements')).toEqual([
      { text: 'Evidence bundles preserve lineage' },
    ]);
    expect(existsSync(join(proj.path, 'openspec'))).toBe(false);
  });

  test('refuses stale previews without applying partial state', async () => {
    const firstSource = groomRealSource('First source-backed line');
    const secondSource = groomRealSource('Second source-backed line');
    const firstPath = await writeDeltaFile('first.json', firstSource, 'batch:first', 'delta:first');
    const secondPath = await writeDeltaFile('second.json', secondSource, 'batch:second', 'delta:second');

    expect(await run(['capability', 'preview', firstPath])).toBe(0);
    const first = JSON.parse(out.join('\n')) as { previewId: string };
    expect(await run(['capability', 'preview', secondPath])).toBe(0);
    const second = JSON.parse(out.join('\n')) as { previewId: string };
    expect(await run(['capability', 'apply', second.previewId, '--accept'])).toBe(0);

    expect(await run(['capability', 'apply', first.previewId, '--accept'])).toBe(1);
    expect(err.join('\n')).toContain('is stale');
    expect(store.db.all('SELECT text FROM capability_statements')).toEqual([
      { text: 'Second source-backed line' },
    ]);
  });

  test('refuses sources that do not cite an accepted revision of the board', async () => {
    const source = groomRealSource('Verified lineage only');
    // synthetic identity that exists on no board
    const fakePath = join(proj.path, 'fake.json');
    await Bun.write(fakePath, JSON.stringify({
      batchId: 'batch:fake',
      deltas: [{
        op: 'add',
        deltaId: 'delta:fake',
        capabilityId: 'capability:evidence',
        statementId: 'statement:fake',
        statementText: 'Fabricated statement.',
        source: {
          cardId: 'card:story',
          criterionId: 'criterion:c-1',
          scopeRevision: 1,
          criterionDigest: criterionTextDigest('Fabricated statement.'),
          evidenceId: 'evidence:ev-1',
          deliveryId: 'delivery:dl-1',
        },
      }],
      sources: [{
        cardId: 'card:story',
        criterionId: 'criterion:c-1',
        scopeRevision: 1,
        criterionText: 'Fabricated statement.',
      }],
      eligibility: [{
        deltaId: 'delta:fake',
        status: 'eligible',
        assurance: 'local',
        evidenceId: 'evidence:ev-1',
        deliveryId: 'delivery:dl-1',
        reasons: [],
        sourceDrift: 'none',
      }],
    }));
    expect(await run(['capability', 'preview', fakePath])).toBe(1);
    expect(err.join('\n')).toContain('has unclassified scope identity');
    expect(store.db.all('SELECT text FROM capability_statements')).toEqual([]);

    // a real card cited at a revision row that does not exist is refused too
    const ghostRevision = join(proj.path, 'ghost.json');
    const ghost = { ...source, scopeRevision: 9 };
    const ghostPath = await writeDeltaFile('ghost.json', ghost, 'batch:ghost', 'delta:ghost');
    void ghostRevision;
    expect(await run(['capability', 'preview', ghostPath])).toBe(1);
    expect(err.join('\n')).toContain('no accepted revision row exists');
  });
});

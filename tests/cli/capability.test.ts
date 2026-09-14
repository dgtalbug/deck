import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { criterionTextDigest } from '../../src/core/board/capability-deltas.ts';
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

async function writeDeltaFile(name: string, text: string, batchId: string, deltaId: string): Promise<string> {
  const path = join(proj.path, name);
  await Bun.write(path, JSON.stringify({
    batchId,
    deltas: [{
      op: 'add',
      deltaId,
      capabilityId: 'capability:evidence',
      statementId: 'statement:lineage',
      statementText: text,
      source: {
        cardId: 'card:story',
        criterionId: 'criterion:c-1',
        scopeRevision: 1,
        criterionDigest: criterionTextDigest(text),
        evidenceId: 'evidence:ev-1',
        deliveryId: 'delivery:dl-1',
      },
    }],
    sources: [{
      cardId: 'card:story',
      criterionId: 'criterion:c-1',
      scopeRevision: 1,
      criterionText: text,
    }],
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
    const path = await writeDeltaFile('delta.json', 'Evidence bundles preserve lineage.', 'batch:cli', 'delta:cli');

    expect(await run(['capability', 'preview', path])).toBe(0);
    const preview = JSON.parse(out.join('\n')) as { previewId: string; state: string };
    expect(preview.state).toBe('previewed');

    expect(await run(['capability', 'apply', preview.previewId])).toBe(64);
    expect(err.join('\n')).toContain('--accept');

    expect(await run(['capability', 'apply', preview.previewId, '--accept', '--by', 'reviewer'])).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ version: 1, reused: false });
    expect(store.db.all('SELECT text FROM capability_statements')).toEqual([
      { text: 'Evidence bundles preserve lineage.' },
    ]);
    expect(existsSync(join(proj.path, 'openspec'))).toBe(false);
  });

  test('refuses stale previews without applying partial state', async () => {
    const firstPath = await writeDeltaFile('first.json', 'First source-backed line.', 'batch:first', 'delta:first');
    const secondPath = await writeDeltaFile('second.json', 'Second source-backed line.', 'batch:second', 'delta:second');

    expect(await run(['capability', 'preview', firstPath])).toBe(0);
    const first = JSON.parse(out.join('\n')) as { previewId: string };
    expect(await run(['capability', 'preview', secondPath])).toBe(0);
    const second = JSON.parse(out.join('\n')) as { previewId: string };
    expect(await run(['capability', 'apply', second.previewId, '--accept'])).toBe(0);

    expect(await run(['capability', 'apply', first.previewId, '--accept'])).toBe(1);
    expect(err.join('\n')).toContain('is stale');
    expect(store.db.all('SELECT text FROM capability_statements')).toEqual([
      { text: 'Second source-backed line.' },
    ]);
  });
});

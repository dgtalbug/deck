import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { tmpProject } from '../helpers.ts';

let path: string;
let cleanup: () => void;
let store: DocumentStore;
let registry: ProjectRegistry;

beforeEach(async () => {
  const project = tmpProject('deck-cli-advisory-');
  path = project.path;
  cleanup = project.cleanup;
  store = await openStore(path);
  registry = new ProjectRegistry();
  registry.register(path, 'advisoryproj');
});

afterEach(() => {
  cleanup();
});

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { registry, cwd: path, io: { out: (t) => out.push(t), err: (t) => err.push(t) } });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function groomed(title: string): string {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: ['has spec content'], sections: { reproduce: 'r', rca: 'c' } },
    specDeltas: [],
    tasks: ['one'],
    openQuestions: [],
  });
  return item.id;
}

describe('baseline and advisory CLI doors', () => {
  test('capture then read reports exact digests and local snapshot provenance', async () => {
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(join(path, 'src', 'probe.ts'), 'export function probeTarget() {}\n', 'utf8');
    const id = groomed('cli capture probe');
    const capture = await cli(['baseline', 'capture', id, 'src/probe.ts']);
    expect(capture.code).toBe(0);
    expect(capture.out).toContain('captured for');
    expect(capture.out).toContain('src/probe.ts digest=');
    expect(capture.out).toContain('.deck/baselines/');

    const read = await cli(['baseline', 'read', id]);
    expect(read.code).toBe(0);
    expect(read.out).toContain('baseline version 1');
    expect(read.out).toContain('snapshot=.deck/baselines/');
  });

  test('compare reports a changed file after capture', async () => {
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(join(path, 'src', 'probe.ts'), 'export const v = 1;\n', 'utf8');
    const id = groomed('cli compare probe');
    await cli(['baseline', 'capture', id, 'src/probe.ts']);
    writeFileSync(join(path, 'src', 'probe.ts'), 'export const v = 2;\n', 'utf8');
    const compare = await cli(['baseline', 'compare', id]);
    expect(compare.code).toBe(0);
    expect(compare.out).toContain('src/probe.ts: changed');
  });

  test('advise renders baseline retrieval and graph fallback states', async () => {
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(join(path, 'src', 'probe.ts'), 'export function probeTarget() {}\n', 'utf8');
    const id = groomed('cli advise probe');
    await cli(['baseline', 'capture', id, 'src/probe.ts']);
    const baselineAdvise = await cli(['baseline', 'advise', id, '--query', 'probeTarget']);
    expect(baselineAdvise.code).toBe(0);
    expect(baselineAdvise.out).toContain('path/keyword retrieval over the selected corpus');
    expect(baselineAdvise.out).toContain('src/probe.ts:probeTarget');

    const graphAdvise = await cli(['baseline', 'advise', id, '--query', 'probeTarget', '--strategy', 'graph']);
    expect(graphAdvise.code).toBe(0);
    expect(graphAdvise.out).toContain('graph retrieval unavailable: graph data is absent');
  });

  test('next --context-advisories is opt-in and invalid values are refused', async () => {
    const id = groomed('cli next advisory probe');
    const plain = await cli(['next']);
    expect(plain.code).toBe(0);
    expect(plain.out).not.toContain('Context advisory');

    const bad = await cli(['next', '--context-advisories', 'quantum']);
    expect(bad.code).toBe(64);
    expect(bad.err).toContain('baseline|graph');

    const advised = await cli(['next', '--context-advisories', 'baseline']);
    expect(advised.code).toBe(0);
    expect(advised.out).toContain('Context advisory (optional)');
    expect(advised.out).toContain('no source baseline captured for this card');
    expect(id.length).toBeGreaterThan(0);
  });
});

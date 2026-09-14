import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import {
  baselineBytes,
  captureSourceBaseline,
  compareSourceBaseline,
  isSecretPath,
  readSourceBaseline,
} from '../../../src/core/board/source-baselines.ts';
import { tmpProject } from '../../helpers.ts';

let store: DocumentStore;
let path: string;
let cleanup: () => void;

beforeEach(() => {
  const project = tmpProject('deck-baseline-');
  path = project.path;
  cleanup = project.cleanup;
});

afterEach(async () => {
  cleanup();
});

function write(pathInProject: string, bytes: string): void {
  const absolute = join(path, pathInProject);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, bytes, 'utf8');
}

async function open(): Promise<DocumentStore> {
  store = await openStore(path);
  return store;
}

describe('source baselines', () => {
  test('a legacy card has no baseline and stays valid', async () => {
    const s = await open();
    const note = s.addNote('legacy card');
    expect(readSourceBaseline(s.db, note.id)).toEqual([]);
    expect(compareSourceBaseline(s, note.id)).toEqual([]);
  });

  test('captures exact dirty bytes and reports unchanged versus changed source', async () => {
    write('src/a.ts', 'export const a = 1;\n');
    write('src/b.ts', 'export const b = 2;\n');
    const s = await open();
    const note = s.addNote('baseline card');
    const capture = captureSourceBaseline(s, note.id, ['src/a.ts', 'src/b.ts']);
    expect(capture.files).toHaveLength(2);
    let changes = compareSourceBaseline(s, note.id);
    expect(changes.map((c) => `${c.path}:${c.status}`).sort()).toEqual(['src/a.ts:unchanged', 'src/b.ts:unchanged']);

    write('src/b.ts', 'export const b = 3;\n');
    changes = compareSourceBaseline(s, note.id);
    const b = changes.find((c) => c.path === 'src/b.ts')!;
    expect(b.status).toBe('changed');
    expect(b.currentDigest).not.toBe(b.baselineDigest);

    const row = readSourceBaseline(s.db, note.id).find((r) => r.path === 'src/b.ts')!;
    expect(baselineBytes(s, row)).toBe('export const b = 2;\n');
  });

  test('a missing path is reported as deleted, a moved identical file as renamed', async () => {
    write('src/old.ts', 'export const same = 1;\n');
    write('src/other.ts', 'export const other = 2;\n');
    const s = await open();
    const note = s.addNote('rename card');
    captureSourceBaseline(s, note.id, ['src/old.ts', 'src/other.ts']);

    rmSync(join(path, 'src', 'old.ts'));
    let changes = compareSourceBaseline(s, note.id);
    expect(changes.find((c) => c.path === 'src/old.ts')!.status).toBe('deleted');

    write('src/other.ts', 'export const same = 1;\n');
    changes = compareSourceBaseline(s, note.id);
    const renamed = changes.find((c) => c.path === 'src/old.ts')!;
    expect(renamed.status).toBe('renamed');
    expect(renamed.renamedTo).toBe('src/other.ts');
  });

  test('a missing snapshot reports unavailable rather than unchanged', async () => {
    write('src/x.ts', 'export const x = 1;\n');
    const s = await open();
    const note = s.addNote('snapshot card');
    const capture = captureSourceBaseline(s, note.id, ['src/x.ts']);
    const row = readSourceBaseline(s.db, note.id)[0]!;
    rmSync(join(path, '.deck', 'baselines', note.id, capture.baselineId), { recursive: true, force: true });
    expect(baselineBytes(s, row)).toBe(null);
    expect(compareSourceBaseline(s, note.id)[0]!.status).toBe('unavailable');
  });

  test('secret-shaped paths are refused without being read', async () => {
    write('.env', 'SECRET=1\n');
    write('src/ok.ts', 'export const ok = 1;\n');
    const s = await open();
    const note = s.addNote('secret card');
    expect(isSecretPath('.env')).toBe(true);
    expect(() => captureSourceBaseline(s, note.id, ['.env'])).toThrow(/secret-shaped/);
    expect(readSourceBaseline(s.db, note.id)).toEqual([]);
  });
});

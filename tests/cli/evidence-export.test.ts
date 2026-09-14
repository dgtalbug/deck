import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
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

beforeEach(async () => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-evidence-cli-');
  registry.register(proj.path);
  store = await openStore(proj.path);
});

afterEach(() => {
  proj.cleanup();
});

describe('evidence export command', () => {
  test('writes a complete offline bundle directory', async () => {
    const epic = store.addEpic('exportable evidence');
    const dir = join(proj.path, 'evidence-out');

    expect(await run(['evidence', 'export', epic.id, '--out', dir])).toBe(0);

    expect(existsSync(join(dir, 'bundle.json'))).toBe(true);
    expect(existsSync(join(dir, 'review.md'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'bundle.json'), 'utf8')).schema).toBe('deck.evidence-bundle');
    expect(readFileSync(join(dir, 'review.md'), 'utf8')).toContain('# Evidence Bundle:');
    expect(out.join('\n')).toContain(`evidence exported: ${dir}`);
  });

  test('refuses an existing destination without overwriting it', async () => {
    const epic = store.addEpic('existing destination');
    const dir = join(proj.path, '.deck');

    expect(await run(['evidence', 'export', epic.id, '--out', dir])).toBe(1);
    expect(err.join('\n')).toContain('evidence export destination already exists');
  });

  test('views an exported bundle and refuses malformed bundle JSON', async () => {
    const epic = store.addEpic('viewable evidence');
    const dir = join(proj.path, 'evidence-view');
    expect(await run(['evidence', 'export', epic.id, '--out', dir])).toBe(0);

    expect(await run(['evidence', 'view', join(dir, 'bundle.json')])).toBe(0);
    expect(out.join('\n')).toContain('# Evidence Bundle:');

    const malformed = join(proj.path, 'broken-bundle.json');
    await Bun.write(malformed, '{"schema":"deck.evidence-bundle","version":"2.0.0"}');
    expect(await run(['evidence', 'view', malformed])).toBe(1);
    expect(err.join('\n')).toContain('invalid evidence bundle');
    expect(err.join('\n')).toContain('unsupported evidence bundle major version');
  });
});

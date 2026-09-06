import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runCli } from '../../src/cli/main.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

// epic-planning — the paired file for the "Epic tree command" requirement:
// deck epic <id> prints the story tree + rollup; deck epics lists; deck
// story attaches; unknown-epic refusal.
let registry: ProjectRegistry;
let proj: TmpProject;
let store: DocumentStore;
let out: string[];
let err: string[];
const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };

async function run(argv: string[]): Promise<number> {
  out = [];
  err = [];
  return runCli(argv, { registry, cwd: proj.path, io });
}

beforeEach(async () => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-epic-cli-');
  registry.register(proj.path);
  store = await openStore(proj.path);
});

afterEach(() => {
  proj.cleanup();
});

describe('epic tree command', () => {
  test('deck epic creates; deck story attaches; deck epic <id> prints tree + rollup', async () => {
    expect(await run(['epic', 'the big feature'])).toBe(0);
    const epicId = out.join('\n').match(/id\s+(\S+)/)![1];
    expect(await run(['story', epicId, 'first story'])).toBe(0);
    expect(await run(['story', epicId, 'second story'])).toBe(0);
    expect(await run(['epic', epicId])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('epic — the big feature');
    expect(text).toContain('0/2 stories done');
    expect(text).toContain('first story');
    expect(text).toContain('second story');
  });

  test('deck epics lists rollups', async () => {
    await run(['epic', 'listed epic']);
    const epicId = out.join('\n').match(/id\s+(\S+)/)![1];
    await run(['story', epicId, 'a story']);
    expect(await run(['epics'])).toBe(0);
    expect(out.join('\n')).toMatch(/0\/1 done\s+listed epic/);
  });

  test('deck epic <unknown> and deck story with a non-epic refuse', async () => {
    expect(await run(['epic', 'ghost-xxxx'])).toBe(1);
    expect(err.join('\n')).toContain("card 'ghost-xxxx' not found");
    const note = store.addNote('plain note');
    expect(await run(['story', note.id, 'title'])).toBe(1);
    expect(err.join('\n')).toContain("epic 'plain-note");
  });
});

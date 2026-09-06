import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runCli } from '../../src/cli/main.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

// verify-fix — the paired file for the "Issue not found message"
// requirement: unknown ids get the typed card-not-found error; a real
// card without an issue gets the no-mapped-issue refusal.
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
  proj = tmpProject('deck-issue-notfound-');
  registry.register(proj.path);
  store = await openStore(proj.path);
});

afterEach(() => {
  proj.cleanup();
});

describe('issue not found message', () => {
  test('an unknown id reports card-not-found, exit 1', async () => {
    expect(await run(['issue', 'ghost'])).toBe(1);
    expect(err.join('\n')).toContain("card 'ghost' not found");
    expect(err.join('\n')).not.toContain('no mapped issue');
  });

  test('a real card without a publish keeps the no-mapped-issue refusal', async () => {
    const note = store.addNote('no issue yet');
    expect(await run(['issue', note.id])).toBe(1);
    expect(err.join('\n')).toContain('no mapped issue');
  });
});

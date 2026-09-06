import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

// hooks-runner — the paired file for the "User verb registration via deck
// workflow" requirement: register → groom → start through the shared
// engine; built-in/duplicate/invalid refuse; unknown verbs stay usage (64).
let registry: ProjectRegistry;
let proj: TmpProject;
let store: DocumentStore;
let binDir: string;
let prevPath: string | undefined;
let out: string[];
let err: string[];
const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: proj.path, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/41" ;;
  "issue view") echo "{"number":41,"state":"OPEN","labels":[{"name":"groomed"}],"url":"u"}" ;;
  "issue edit"|"issue close") echo ok ;;
  "pr create") echo "https://github.com/o/r/pull/51" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function groomUserVerb(title: string, verb: string): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: verb,
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['implement'],
    openQuestions: [],
  });
  return note.id;
}

function run(argv: string[]): Promise<number> {
  out = [];
  err = [];
  return runCli(argv, { registry, cwd: proj.path, io });
}

beforeEach(async () => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-cli-user-verb-');
  binDir = mkdtempSync(join(tmpdir(), 'deck-cli-user-verb-bin-'));
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(proj.path, '.gitignore'), 'bin/\n.deck/\nspecs/\norigin.git/\n');
  git('init --bare origin.git');
  git('remote add origin ./origin.git');
  writeFileSync(join(proj.path, 'a.txt'), 'one\n');
  git('add .');
  git('commit -m "c1"');
  git('push -u origin main');
  registry.register(proj.path);
  store = await openStore(proj.path);
});

afterEach(() => {
  proj.cleanup();
  rmSync(binDir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
});

describe('deck workflow', () => {
  test('register → groom → deck <new-verb> starts through the shared engine', async () => {
    stubGh();
    expect(await run(['workflow', 'ship'])).toBe(0);
    expect(out.join('\n')).toContain("verb 'ship' registered");
    const id = groomUserVerb('ship the thing', 'ship');
    expect(await run(['ship', id])).toBe(0);
    expect(out.join('\n')).toContain('ship started — ship the thing');
    expect(git('rev-parse --abbrev-ref HEAD').trim()).toMatch(/^ship\//);
    expect(store.getVerbItem(id).lane).toBe('active');
  });

  test('duplicate registration is idempotent-success; built-in and invalid names refuse', async () => {
    expect(await run(['workflow', 'ship'])).toBe(0);
    expect(await run(['workflow', 'ship'])).toBe(0); // idempotent
    expect(await run(['workflow', 'feat'])).toBe(1);
    expect(err.join('\n')).toContain('built-in');
    expect(await run(['workflow', 'Ship_It'])).toBe(1);
    expect(err.join('\n')).toContain('invalid');
  });

  test('grooming with an unregistered verb refuses with the typed error', async () => {
    const note = store.addNote('never registered');
    let threw = false;
    try {
      convertToVerbItem(store, {
        noteId: note.id,
        proposedVerb: 'ghost',
        refinedTitle: 'never registered',
        research: { codebaseFindings: [] },
        specDeltas: [],
        tasks: ['implement'],
        openQuestions: [],
      });
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain("not registered");
    }
    expect(threw).toBe(true);
    expect(store.getNote(note.id).id).toBe(note.id);
  });

  test('an unregistered unknown verb remains the usage error (exit 64)', async () => {
    expect(await run(['teleport', 'c1'])).toBe(64);
    expect(err.join('\n')).toContain("unknown command 'teleport'");
  });
});

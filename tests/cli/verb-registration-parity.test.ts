import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import type { Verb } from '../../src/core/board/types.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

// verb-registrations — the paired file for the "Verb registration parity"
// requirement: the 9 remaining verbs are one-line registrations over the
// shared engine; the CLI door proves the parity with feat/fix.
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

function groomVerb(title: string, verb: Verb): string {
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
  proj = tmpProject('deck-cli-verb-parity-');
  binDir = mkdtempSync(join(tmpdir(), 'deck-cli-verb-parity-bin-'));
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

// verb-registrations — the 9 remaining verbs are one-line registrations over
// the shared engine; the CLI door proves the parity with feat/fix.
describe('verb registration parity', () => {
  test('deck docs starts a build round-trip', async () => {
    stubGh();
    const id = groomVerb('docs the api', 'docs');
    expect(await run(['docs', id])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('docs started — docs the api');
    expect(text).toMatch(/branch\s+docs\//);
    expect(store.getVerbItem(id).lane).toBe('active');
  });

  test('deck chore starts a build round-trip', async () => {
    stubGh();
    const id = groomVerb('chore the deps', 'chore');
    expect(await run(['chore', id])).toBe(0);
    expect(out.join('\n')).toContain('chore started — chore the deps');
    expect(git('rev-parse --abbrev-ref HEAD').trim()).toMatch(/^chore\//);
  });

  test('verb mismatch on a registered verb exits 1 with the typed message', async () => {
    stubGh();
    const id = groomVerb('chore mismatch card', 'chore');
    expect(await run(['feat', id])).toBe(1);
    expect(err.join('\n')).toContain("groomed as 'chore'");
    expect(store.getVerbItem(id).lane).toBe('groomed');
  });

  test('USAGE lists every registered verb', async () => {
    expect(await run(['nope'])).toBe(64);
    const usage = err.join('\n');
    expect(usage).toContain('feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert');
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

// Task 4.2 — the terminal door over the verb engine: start round-trip and
// typed-refusal exit codes.
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
  "issue view") echo "{\\"number\\":41,\\"state\\":\\"OPEN\\",\\"labels\\":[{\\"name\\":\\"groomed\\"}],\\"url\\":\\"u\\"}" ;;
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

function groomed(title: string, verb: 'feat' | 'fix' = 'feat'): string {
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
  proj = tmpProject('deck-cli-verbs-');
  binDir = mkdtempSync(join(tmpdir(), 'deck-cli-verbs-bin-'));
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

describe('deck feat / deck fix', () => {
  test('start round-trip: active + branch + issue + deck next pointer', async () => {
    stubGh();
    const id = groomed('cli gate card');
    expect(await run(['feat', id])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('feat started — cli gate card');
    expect(text).toContain('→ active');
    expect(text).toMatch(/branch\s+feat\//);
    expect(text).toContain('#41');
    expect(text).toContain('deck next');
    expect(store.getVerbItem(id).lane).toBe('active');
  });

  test('verb mismatch exits non-zero with the typed message', async () => {
    stubGh();
    const id = groomed('cli fix card', 'fix');
    expect(await run(['feat', id])).toBe(1);
    expect(err.join('\n')).toContain("groomed as 'fix'");
    expect(store.getVerbItem(id).lane).toBe('groomed');
  });

  test('deck fix starts on the shared engine', async () => {
    stubGh();
    const id = groomed('cli shared engine', 'fix');
    expect(await run(['fix', id])).toBe(0);
    expect(out.join('\n')).toContain('fix started — cli shared engine');
    expect(git('rev-parse --abbrev-ref HEAD').trim()).toMatch(/^fix\//);
  });
});

describe('deck archive', () => {
  test('archives end-to-end from the terminal', async () => {
    stubGh();
    const id = groomed('cli archive card');
    await run(['feat', id]);
    writeFileSync(join(proj.path, 'b.txt'), 'the fix\n');
    git('add .');
    git('commit -m "feat: the fix"');
    expect(await run(['archive', id])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('archived — cli archive card');
    expect(text).toContain('https://github.com/o/r/pull/51');
    expect(text).toContain('#41 closed');
    expect(store.getVerbItem(id).lane).toBe('done');
    expect(git('rev-parse --abbrev-ref HEAD').trim()).toBe('main');
  });
});

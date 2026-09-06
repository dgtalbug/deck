import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { startVerb } from '../../src/core/engine/verbs.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

// Task 5.3 — the terminal door: computed deck verify (gaps exit non-zero,
// clean zero, override unchanged) and deck review (danger output + codes).
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
  "issue create") echo "https://github.com/o/r/issues/105" ;;
  "issue view") echo "{\\"number\\":105,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function groomed(title: string, tasks: string[]): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks,
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
  proj = tmpProject('deck-cli-verify-');
  binDir = mkdtempSync(join(tmpdir(), 'deck-cli-verify-bin-'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(proj.path, '.gitignore'), 'bin/\n.deck/\nspecs/\n');
  writeFileSync(join(proj.path, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m "c1"');
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

describe('deck verify (computed)', () => {
  test('gaps print and exit non-zero; card loops to active', async () => {
    stubGh();
    const id = groomed('cli gap card', ['the unfinished bit']);
    await publishSpec(store, id);
    moveLane(store, id, 'active', 'engine');
    moveLane(store, id, 'verify', 'engine');
    expect(await run(['verify', id])).toBe(1);
    expect(out.join('\n')).toContain('gap  the unfinished bit');
    expect(store.getVerbItem(id).lane).toBe('active');
  });

  test('clean prints and exits zero', async () => {
    stubGh();
    const id = groomed('cli clean card', ['finished bit']);
    await publishSpec(store, id);
    moveLane(store, id, 'active', 'engine');
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    moveLane(store, id, 'verify', 'engine');
    expect(await run(['verify', id])).toBe(0);
    expect(out.join('\n')).toContain('clean');
    expect(store.getVerbItem(id).lane).toBe('done');
  });

  test('explicit --result override keeps the old contract', async () => {
    stubGh();
    const id = groomed('cli override card', ['work']);
    await publishSpec(store, id);
    moveLane(store, id, 'active', 'engine');
    moveLane(store, id, 'verify', 'engine');
    expect(await run(['verify', id, '--result', 'clean'])).toBe(0);
    expect(store.getVerbItem(id).lane).toBe('done');
  });
});

describe('deck review', () => {
  test('findings render danger-toned and exit non-zero; archive stays blocked', async () => {
    stubGh();
    const id = groomed('cli finding card', ['never done task']);
    await startVerb(store, id, 'feat');
    expect(await run(['review', id])).toBe(1);
    expect(out.join('\n')).toMatch(/^! .* — violates /m);
  });

  test('clean review exits zero', async () => {
    stubGh();
    const id = groomed('cli reviewable card', ['all finished']);
    await startVerb(store, id, 'feat');
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    expect(await run(['review', id])).toBe(0);
    expect(out.join('\n')).toContain('review clean');
  });
});

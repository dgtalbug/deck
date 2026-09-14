import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { createWorkspace } from '../../src/core/projects/workspaces.ts';
import { startVerb } from '../../src/core/engine/verbs.ts';
import { executionPath, RecoveryRequiredError } from '../../src/core/board/context.ts';
import { tmpProject } from '../helpers.ts';

let project: ReturnType<typeof tmpProject>;
let home: string;
let store: DocumentStore;
let binDir: string;
let prevPath: string | undefined;

function git(command: string, cwd = project.path): string {
  return execSync(`git ${command}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function worktreesDir(): string {
  return join(tmpdir(), `${basename(project.path)}-worktrees`);
}

function stubGh(): void {
  binDir = join(tmpdir(), `deck-wtx-bin-${Date.now()}`);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/9" ;;
  "issue view") echo "{\\"number\\":9,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  "issue edit"|"issue close") echo ok ;;
  "pr create") echo "https://github.com/o/r/pull/9" ;;
  "pr list") echo "[]" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

async function groomed(title: string, tasks = ['implement']): Promise<string> {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [{ op: 'ADDED', requirement: 'req', text: 'text' }],
    tasks,
    openQuestions: [],
  });
  return item.id;
}

beforeAll(async () => {
  home = join(tmpdir(), `deck-wtx-home-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env['DECK_HOME'] = home;
  project = tmpProject('deck-wtree-exec-');
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(project.path, '.gitignore'), '.deck/\nspecs/\n');
  writeFileSync(join(project.path, 'deck.config.yaml'), 'board:\n  wipLimit: 8\n');
  writeFileSync(join(project.path, 'a.txt'), 'one\n');
  git('add . && git commit -m "c1"');
  git('init --bare origin.git');
  git('remote add origin ./origin.git');
  git('push -u origin main');
  store = await openStore(project.path);
});

afterAll(() => {
  if (prevPath !== undefined) process.env['PATH'] = prevPath;
  rmSync(worktreesDir(), { recursive: true, force: true });
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

describe('worktree execution', () => {
  test('two worktrees start independent stories: distinct HEADs, one event history, shared WIP', async () => {
    stubGh();
    const alpha = createWorkspace(store, { name: 'alpha' });
    const beta = createWorkspace(store, { name: 'beta' });
    const cardA = await groomed('alpha story');
    const cardB = await groomed('beta story');

    const startedA = await startVerb(store, cardA, 'feat', { workspacePath: alpha.path! });
    const startedB = await startVerb(store, cardB, 'feat', { workspacePath: beta.path! });

    expect(git('rev-parse --abbrev-ref HEAD', alpha.path!).trim()).toBe(startedA.branch);
    expect(git('rev-parse --abbrev-ref HEAD', beta.path!).trim()).toBe(startedB.branch);
    // independent commits give the two worktrees distinct HEADs
    writeFileSync(join(alpha.path!, 'alpha.txt'), 'a\n');
    git('add . && git commit -m "alpha"', alpha.path!);
    writeFileSync(join(beta.path!, 'beta.txt'), 'b\n');
    git('add . && git commit -m "beta"', beta.path!);
    const headA = git('rev-parse HEAD', alpha.path!).trim();
    const headB = git('rev-parse HEAD', beta.path!).trim();
    const headCanonical = git('rev-parse HEAD').trim();
    expect(new Set([headA, headB, headCanonical]).size).toBe(3);

    // one shared event history and board
    const eventsA = store.raw().query('SELECT COUNT(*) c FROM events').get() as { c: number };
    expect(eventsA.c).toBeGreaterThan(0);
    expect(store.getVerbItem(cardA).lane).toBe('active');
    expect(store.getVerbItem(cardB).lane).toBe('active');
  });

  test('same-card duplicate start refuses across worktrees', async () => {
    stubGh();
    const card = await groomed('duplicate gate story');
    const alpha = createWorkspace(store, { name: 'dup-alpha' });
    await startVerb(store, card, 'feat', { workspacePath: alpha.path! });
    const beta = createWorkspace(store, { name: 'dup-beta' });
    await expect(startVerb(store, card, 'feat', { workspacePath: beta.path! })).rejects.toThrow(/active|already|claimable/);
  });

  test('hooks and checks read the assigned workspace, not the canonical checkout', async () => {
    stubGh();
    const alpha = createWorkspace(store, { name: 'sentinel' });
    const card = await groomed('sentinel story');
    await startVerb(store, card, 'feat', { workspacePath: alpha.path! });
    writeFileSync(join(alpha.path!, 'sentinel-ws.txt'), 'workspace\n');
    expect(executionPath(store, card)).toBe(alpha.path!);

    // canonical checkout does NOT see the sentinel; assigned path does
    expect(existsSync(join(project.path, 'sentinel-ws.txt'))).toBe(false);
    expect(existsSync(join(alpha.path!, 'sentinel-ws.txt'))).toBe(true);
  });

  test('missing assigned path on resume refuses with recovery details', async () => {
    stubGh();
    const alpha = createWorkspace(store, { name: 'vanish' });
    const card = await groomed('vanish story');
    await startVerb(store, card, 'feat', { workspacePath: alpha.path! });
    rmSync(alpha.path!, { recursive: true, force: true });
    git('worktree prune');
    expect(() => executionPath(store, card)).toThrow(RecoveryRequiredError);
    // and the canonical board still opens
    expect(store.getVerbItem(card).lane).toBe('active');
  });
});

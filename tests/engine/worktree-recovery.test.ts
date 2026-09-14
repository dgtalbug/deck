import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import {
  cancelWorkspace,
  createWorkspace,
  reconcileWorkspace,
  WorkspaceError,
} from '../../src/core/projects/workspaces.ts';
import { tmpProject } from '../helpers.ts';

let project: ReturnType<typeof tmpProject>;
let home: string;
let store: DocumentStore;

function git(command: string, cwd = project.path): string {
  return execSync(`git ${command}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function worktreesDir(): string {
  return join(tmpdir(), `${basename(project.path)}-worktrees`);
}

beforeAll(async () => {
  home = join(tmpdir(), `deck-wtr-home-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env['DECK_HOME'] = home;
  project = tmpProject('deck-wtree-recovery-');
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(project.path, 'a.txt'), 'one\n');
  git('add . && git commit -m "c1"');
  store = await openStore(project.path);
});

afterAll(() => {
  rmSync(worktreesDir(), { recursive: true, force: true });
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

describe('worktree recovery', () => {
  test('crash between intent and git effect leaves an inspectable creating row', async () => {
    const id = 'ws-crash-probe';
    store.raw()
      .query(
        `INSERT INTO workspaces (id, project_path, path, branch, state, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'creating', ?, ?)`,
      )
      .run(id, project.path, 'deck/w/crash-probe', new Date().toISOString(), new Date().toISOString());
    const health = reconcileWorkspace(store, id);
    expect(health.status).toBe('recovery-required');
    expect(health.detail).toMatch(/missing/);
  });

  test('existing branch name refuses creation', () => {
    git('branch deck/w/taken');
    expect(() => createWorkspace(store, { name: 'taken' })).toThrow(WorkspaceError);
  });

  test('existing path refuses creation', () => {
    mkdirSync(join(worktreesDir(), 'occupied'), { recursive: true });
    expect(() => createWorkspace(store, { name: 'occupied' })).toThrow(/already exists/);
    rmSync(join(worktreesDir(), 'occupied'), { recursive: true, force: true });
  });

  test('head drift flags recovery', () => {
    const workspace = createWorkspace(store, { name: 'drift' });
    writeFileSync(join(workspace.path!, 'drift.txt'), 'd\n');
    git('add . && git commit -m "drift"', workspace.path!);
    const health = reconcileWorkspace(store, workspace.id);
    expect(health.status).toBe('recovery-required');
    expect(health.detail).toMatch(/HEAD/);
  });

  test('dirty cancellation preserves files and reports pending cleanup', () => {
    const workspace = createWorkspace(store, { name: 'dirty' });
    writeFileSync(join(workspace.path!, 'uncommitted.txt'), 'keep me\n');
    expect(() => cancelWorkspace(store, workspace.id)).toThrow(/uncommitted changes/);
    expect(require('node:fs').existsSync(join(workspace.path!, 'uncommitted.txt'))).toBe(true);
    // after committing, cancel succeeds and removes only the owned tree
    git('add . && git commit -m "ws work"', workspace.path!);
    const cancelled = cancelWorkspace(store, workspace.id);
    expect(cancelled.state).toBe('detached');
    expect(require('node:fs').existsSync(workspace.path!)).toBe(false);
    // the owned branch carries unmerged work — it stays with an actionable note, never force-deleted
    expect(cancelled.pendingCleanup?.[0]).toMatch(/not fully merged/);
    git(`branch -D ${workspace.branch}`);
  });

  test('cancellation never deletes an unrelated branch', () => {
    const workspace = createWorkspace(store, { name: 'related' });
    git('branch unrelated-keep');
    git('add . && git commit -m "bump" --allow-empty', workspace.path!);
    cancelWorkspace(store, workspace.id);
    expect(git(`branch --list unrelated-keep`).trim()).not.toBe('');
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ProjectRegistry } from '../../../src/core/projects/registry.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import {
  attachWorkspace,
  cancelWorkspace,
  createWorkspace,
  resolveProjectStore,
  WorkspaceError,
} from '../../../src/core/projects/workspaces.ts';
import { tmpProject } from '../../helpers.ts';

let registry: ProjectRegistry;
let home: string;
let project: ReturnType<typeof tmpProject>;
let store: DocumentStore;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: project.path, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

beforeAll(async () => {
  home = join(tmpdir(), `deck-ws-home-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  project = tmpProject('deck-workspaces-');
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(project.path, 'a.txt'), 'one\n');
  git('add .');
  git('commit -m "c1"');
  registry.register(project.path, 'wsproj');
  store = await openStore(project.path);
});

afterAll(() => {
  registry.close();
  rmSync(join(tmpdir(), `${basename(project.path)}-worktrees`), { recursive: true, force: true });
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

describe('workspaces', () => {
  test('same-board discovery: canonical checkout resolves without a workspace', async () => {
    const resolved = await resolveProjectStore(registry, project.path);
    expect(resolved.workspace).toBeNull();
    expect(resolved.canonicalPath).toBe(realpath(project.path));
  });

  test('create → attach shares one board with a distinct HEAD', async () => {
    const workspace = createWorkspace(store, { name: 'alpha' });
    expect(workspace.state).toBe('attached');
    expect(workspace.path).not.toBe(realpath(project.path));
    const head = execSync('git rev-parse HEAD', { cwd: workspace.path! }).toString().trim();
    expect(workspace.expectedHead).toBe(head);

    writeFileSync(join(workspace.path!, 'sentinel-ws.txt'), 'ws\n');
    execSync('git add . && git commit -m "ws commit"', { cwd: workspace.path! });
    const resolved = await resolveProjectStore(registry, workspace.path!);
    expect(resolved.store.dbPath).toBe(store.dbPath);
    expect(resolved.workspace?.id).toBe(workspace.id);
    // distinct HEADs
    const canonicalHead = execSync('git rev-parse HEAD', { cwd: project.path }).toString().trim();
    const wsHead = execSync('git rev-parse HEAD', { cwd: workspace.path! }).toString().trim();
    expect(wsHead).not.toBe(canonicalHead);
  });

  test('symlinked workspace path still resolves to the same record', async () => {
    const workspace = createWorkspace(store, { name: 'beta' });
    const link = join(tmpdir(), `deck-ws-link-${Date.now()}`);
    execSync(`ln -s ${workspace.path} ${link}`);
    const resolved = await resolveProjectStore(registry, link);
    expect(resolved.workspace?.id).toBe(workspace.id);
    execSync(`rm ${link}`);
  });

  test('separate board database refuses attachment', async () => {
    const workspace = createWorkspace(store, { name: 'gamma' });
    mkdirSync(join(workspace.path!, '.deck'), { recursive: true });
    writeFileSync(join(workspace.path!, '.deck', 'board.sqlite'), 'x');
    expect(() => attachWorkspace(store, workspace.path!)).toThrow(/never merges separate board databases/);
    rmSync(join(workspace.path!, '.deck'), { recursive: true, force: true });
    cancelWorkspace(store, workspace.id);
  });

  test('foreign git repository refuses attachment', async () => {
    const foreign = tmpProject('deck-ws-foreign-');
    execSync('git init', { cwd: foreign.path });
    expect(() => attachWorkspace(store, foreign.path)).toThrow(/foreign repository/);
    foreign.cleanup();
  });

  test('missing assigned path reports recovery instead of opening an empty board', async () => {
    const workspace = createWorkspace(store, { name: 'delta' });
    rmSync(workspace.path!, { recursive: true, force: true });
    execSync('git worktree prune', { cwd: project.path });
    const resolved = resolveProjectStore(registry, workspace.path!).then(
      () => 'resolved',
      (error: unknown) => (error instanceof WorkspaceError ? error.message : `unexpected: ${String(error)}`),
    );
    expect(await resolved).toMatch(/recovery|required|not an attached workspace|missing/);
  });
});

function realpath(p: string): string {
  return execSync(`realpath ${p}`).toString().trim();
}

import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { DeckError } from '../board/errors.ts';
import { runTx, type DocumentStore } from '../board/store.ts';
import { operations, workspaces, type WorkspaceRow } from '../board/schema.ts';
import type { ProjectRegistry } from './registry.ts';
import { getStore } from './stores.ts';

export const WORKSPACE_BRANCH_PREFIX = 'deck/w/';

export class WorkspaceError extends DeckError {}

export interface Workspace {
  id: string;
  projectPath: string;
  path: string | null;
  branch: string;
  expectedHead: string | null;
  state: WorkspaceRow['state'];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  pendingCleanup?: string[] | undefined;
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return { ...row };
}

function nowIso(): string {
  return new Date().toISOString();
}

export function gitOutput(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new WorkspaceError(
      `git ${args[0]} failed in ${cwd}: ${proc.stderr.toString().trim()}`,
      { cwd, args, stderr: proc.stderr.toString().trim() },
    );
  }
  return proc.stdout.toString().trim();
}

export function gitCommonDir(cwd: string): string {
  return gitOutput(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
}

function pathExists(path: string | null): path is string {
  return path !== null && existsSync(path);
}

export function listWorkspaces(store: DocumentStore): Workspace[] {
  return store.db.select().from(workspaces).all().map(toWorkspace);
}

export function getWorkspace(store: DocumentStore, id: string): Workspace {
  const row = store.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  if (row === undefined) throw new WorkspaceError(`workspace '${id}' not found`, { workspaceId: id });
  return toWorkspace(row);
}

function branchTaken(store: DocumentStore, branch: string): boolean {
  return store.db.select().from(workspaces).where(eq(workspaces.branch, branch)).all().some((row) => row.state !== 'detached');
}

export function createWorkspace(
  store: DocumentStore,
  input: { name: string },
): Workspace {
  if (!/^[a-z][a-z0-9-]*$/.test(input.name)) {
    throw new WorkspaceError(
      `workspace name '${input.name}' is invalid — lower-case letters, digits, dashes, starting with a letter`,
      { name: input.name },
    );
  }
  const branch = `${WORKSPACE_BRANCH_PREFIX}${input.name}`;
  if (branchTaken(store, branch)) {
    throw new WorkspaceError(`workspace branch '${branch}' is already in use`, { branch });
  }
  const canonical = realpathSync(store.projectPath);
  const target = join(canonical, '..', `${basename(canonical)}-worktrees`, input.name);
  if (existsSync(target)) {
    throw new WorkspaceError(
      `worktree path ${target} already exists — choose another name or attach it explicitly`,
      { path: target },
    );
  }

  const id = `ws-${randomUUID()}`;
  const ts = nowIso();
  runTx(store.db, (tx) => {
    tx.insert(workspaces)
      .values({ id, projectPath: canonical, path: null, branch, state: 'creating', createdAt: ts, updatedAt: ts })
      .run();
  });

  try {
    gitOutput(canonical, ['worktree', 'add', '-b', branch, target]);
  } catch (error) {
    const updated = nowIso();
    runTx(store.db, (tx) => {
      tx.update(workspaces).set({ state: 'recovery-required', updatedAt: updated }).where(eq(workspaces.id, id)).run();
    });
    throw error;
  }

  const attached = nowIso();
  const path = realpathSync(target);
  const head = gitOutput(path, ['rev-parse', 'HEAD']);
  runTx(store.db, (tx) => {
    tx.update(workspaces)
      .set({ state: 'attached', path, expectedHead: head, updatedAt: attached })
      .where(eq(workspaces.id, id))
      .run();
  });
  return { id, projectPath: canonical, path, branch, expectedHead: head, state: 'attached', createdAt: ts, updatedAt: attached, closedAt: null };
}

export function attachWorkspace(store: DocumentStore, target: string): Workspace {
  const canonical = realpathSync(store.projectPath);
  const real = realpathSync(target);
  if (real === canonical) {
    throw new WorkspaceError(
      `path ${real} is the canonical checkout itself — nothing to attach`,
      { path: real },
    );
  }
  const canonicalCommon = gitCommonDir(canonical);
  let targetCommon: string;
  try {
    targetCommon = gitCommonDir(real);
  } catch (error) {
    throw new WorkspaceError(
      `path ${real} is not inside a Git repository — workspaces attach to existing worktrees only`,
      { path: real },
    );
  }
  if (targetCommon !== canonicalCommon) {
    throw new WorkspaceError(
      `path ${real} belongs to repository ${targetCommon}, not ${canonicalCommon} — ` +
        `refusing to attach a foreign repository's worktree`,
      { path: real, targetCommon, canonicalCommon },
    );
  }
  const foreignBoard = join(real, '.deck', 'board.sqlite');
  if (existsSync(foreignBoard)) {
    const stat = statSync(foreignBoard);
    if (!stat.isSymbolicLink()) {
      throw new WorkspaceError(
        `path ${real} carries its own board database — deck never merges separate board databases; ` +
          `remove or rename it before attaching`,
        { path: real, foreignBoard },
      );
    }
  }

  const existing = store.db.select().from(workspaces).where(eq(workspaces.path, real)).get();
  const branch = gitOutput(real, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = gitOutput(real, ['rev-parse', 'HEAD']);
  const ts = nowIso();
  if (existing !== undefined) {
    runTx(store.db, (tx) => {
      tx.update(workspaces)
        .set({ state: 'attached', branch, expectedHead: head, updatedAt: ts, closedAt: null })
        .where(eq(workspaces.id, existing.id))
        .run();
    });
    return { ...toWorkspace(existing), state: 'attached', branch, expectedHead: head, updatedAt: ts, closedAt: null };
  }
  const id = `ws-${randomUUID()}`;
  runTx(store.db, (tx) => {
    tx.insert(workspaces)
      .values({ id, projectPath: canonical, path: real, branch, expectedHead: head, state: 'attached', createdAt: ts, updatedAt: ts })
      .run();
  });
  return { id, projectPath: canonical, path: real, branch, expectedHead: head, state: 'attached', createdAt: ts, updatedAt: ts, closedAt: null };
}

export interface WorkspaceHealth {
  workspace: Workspace;
  status: 'ok' | 'recovery-required' | 'detached';
  detail: string;
}

export function reconcileWorkspace(store: DocumentStore, id: string): WorkspaceHealth {
  const workspace = getWorkspace(store, id);
  if (workspace.state === 'detached') return { workspace, status: 'detached', detail: 'workspace is detached' };
  if (!pathExists(workspace.path)) {
    const detail = `assigned path ${workspace.path ?? '(none)'} is missing — restore it or cancel the workspace record`;
    markRecovery(store, id, detail);
    return { workspace: { ...workspace, state: 'recovery-required' }, status: 'recovery-required', detail };
  }
  const registered = gitOutput(realpathSync(store.projectPath), ['worktree', 'list', '--porcelain'])
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => /^worktree (.+)$/m.exec(block)?.[1]);
  if (!registered.includes(workspace.path)) {
    const detail = `path ${workspace.path} is no longer a registered worktree of this repository — it was replaced or pruned`;
    markRecovery(store, id, detail);
    return { workspace: { ...workspace, state: 'recovery-required' }, status: 'recovery-required', detail };
  }
  const head = gitOutput(workspace.path, ['rev-parse', 'HEAD']);
  if (workspace.expectedHead !== null && head !== workspace.expectedHead) {
    const detail = `expected HEAD ${workspace.expectedHead} but path ${workspace.path} is at ${head} — confirm and re-attach`;
    markRecovery(store, id, detail);
    return { workspace: { ...workspace, state: 'recovery-required' }, status: 'recovery-required', detail };
  }
  return { workspace, status: 'ok', detail: 'workspace is consistent' };
}

function markRecovery(store: DocumentStore, id: string, detail: string): void {
  runTx(store.db, (tx) => {
    tx.update(workspaces).set({ state: 'recovery-required', updatedAt: nowIso() }).where(eq(workspaces.id, id)).run();
  });
  void detail;
}

export function cancelWorkspace(store: DocumentStore, id: string): Workspace {
  const workspace = getWorkspace(store, id);
  if (workspace.state === 'detached') {
    throw new WorkspaceError(`workspace '${id}' is already detached`, { workspaceId: id });
  }
  if (!pathExists(workspace.path)) {
    const ts = nowIso();
    runTx(store.db, (tx) => {
      tx.update(workspaces).set({ state: 'detached', closedAt: ts, updatedAt: ts, path: null }).where(eq(workspaces.id, id)).run();
    });
    return { ...workspace, state: 'detached', path: null, closedAt: ts, updatedAt: ts };
  }
  const unsettled = store.db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.checkout, workspace.path),
        inArray(operations.state, ['reserved', 'active', 'recovery-required']),
      ),
    )
    .all();
  if (unsettled.length > 0) {
    throw new WorkspaceError(
      `workspace '${id}' still has unsettled engine operation(s) ${unsettled.map((op) => op.id).join(', ')} — ` +
        `reconcile them (deck ops reconcile) before cancelling`,
      { workspaceId: id, operations: unsettled.map((op) => ({ id: op.id, state: op.state })) },
    );
  }
  const dirty = gitOutput(workspace.path, ['status', '--porcelain']);
  if (dirty.length > 0) {
    throw new WorkspaceError(
      `worktree ${workspace.path} has uncommitted changes — deck never force-removes dirty trees; ` +
        `commit or stash them, then retry the cancel`,
      { workspaceId: id, path: workspace.path, dirty: dirty.split('\n') },
    );
  }
  gitOutput(realpathSync(store.projectPath), ['worktree', 'remove', workspace.path]);
  const pendingCleanup: string[] = [];
  if (workspace.branch.startsWith(WORKSPACE_BRANCH_PREFIX)) {
    try {
      gitOutput(realpathSync(store.projectPath), ['branch', '-d', workspace.branch]);
    } catch {
      pendingCleanup.push(
        `branch ${workspace.branch} is not fully merged — kept; delete it manually (git branch -D ${workspace.branch}) once you are sure`,
      );
    }
  }
  const ts = nowIso();
  runTx(store.db, (tx) => {
    tx.update(workspaces).set({ state: 'detached', closedAt: ts, updatedAt: ts, path: null }).where(eq(workspaces.id, id)).run();
  });
  return {
    ...workspace,
    state: 'detached' as const,
    path: null,
    closedAt: ts,
    updatedAt: ts,
    ...(pendingCleanup.length > 0 ? { pendingCleanup } : {}),
  };
}

export interface ResolvedStore {
  store: DocumentStore;
  canonicalPath: string;
  workspace: Workspace | null;
}

export async function resolveProjectStore(registry: ProjectRegistry, cwd: string): Promise<ResolvedStore> {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    throw new WorkspaceError(
      `path ${cwd} does not exist — if this was an assigned workspace path it needs recovery (deck workspace status)`,
      { path: cwd },
    );
  }
  const exact = registry.list().find((project) => {
    try {
      return realpathSync(project.path) === real;
    } catch {
      return false;
    }
  });
  if (exact !== undefined) {
    return { store: await getStore(exact.path), canonicalPath: realpathSync(exact.path), workspace: null };
  }

  const common = gitCommonDir(real);
  const owner = registry.list().find((project) => {
    try {
      return gitCommonDir(realpathSync(project.path)) === common;
    } catch {
      return false;
    }
  });
  if (owner === undefined) {
    throw new WorkspaceError(
      `no registered project owns the repository at ${common} — run deck init in the canonical checkout first`,
      { common },
    );
  }
  const canonicalPath = realpathSync(owner.path);
  const store = await getStore(owner.path);
  const row = store.db.select().from(workspaces).where(eq(workspaces.path, real)).get();
  if (row === undefined || row.state !== 'attached') {
    throw new WorkspaceError(
      `path ${real} is not an attached workspace of project ${owner.name} — ` +
        `attach it from the canonical checkout (deck workspace attach) or open the canonical path`,
      { path: real, project: owner.name },
    );
  }
  return { store, canonicalPath, workspace: toWorkspace(row) };
}

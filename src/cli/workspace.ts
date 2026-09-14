import {
  attachWorkspace,
  cancelWorkspace,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  reconcileWorkspace,
  WorkspaceError,
} from '../core/projects/workspaces.ts';
import { getStore } from '../core/projects/stores.ts';
import { resolveProject } from './context.ts';
import { flagString, UsageError, type ParsedArgs } from './args.ts';
import type { RunContext } from './main.ts';

export async function workspaceCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const sub = args.positionals[0];
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);

  if (sub === undefined || sub === 'status') {
    const rows = listWorkspaces(store);
    if (rows.length === 0) return `no workspaces — checkout mode (canonical ${project.path})`;
    const lines = rows.map((row) => {
      const health = row.state === 'attached' ? reconcileWorkspace(store, row.id) : undefined;
      const detail = health === undefined ? '' : health.status === 'ok' ? '' : ` — RECOVERY: ${health.detail}`;
      return `${row.id} ${row.state} ${row.branch} ${row.path ?? '(no path)'}${detail}`;
    });
    return [`canonical: ${project.path}`, ...lines].join('\n');
  }

  if (sub === 'create') {
    const name = flagString(args.flags, 'name') ?? args.positionals[1];
    if (name === undefined) throw new UsageError('usage: deck workspace create --name <name>');
    const workspace = createWorkspace(store, { name });
    return `workspace ${workspace.id} attached at ${workspace.path} (branch ${workspace.branch}) — one board, isolated checkout`;
  }

  if (sub === 'attach') {
    const path = args.positionals[1] ?? flagString(args.flags, 'path');
    if (path === undefined) throw new UsageError('usage: deck workspace attach <path>');
    const workspace = attachWorkspace(store, path);
    return `workspace ${workspace.id} attached at ${workspace.path} (branch ${workspace.branch})`;
  }

  if (sub === 'reconcile') {
    const id = args.positionals[1];
    if (id === undefined) throw new UsageError('usage: deck workspace reconcile <workspace-id>');
    const health = reconcileWorkspace(store, id);
    return `${health.status}: ${health.detail}`;
  }

  if (sub === 'cancel') {
    const id = args.positionals[1];
    if (id === undefined) throw new UsageError('usage: deck workspace cancel <workspace-id>');
    const workspace = getWorkspace(store, id);
    const cancelled = cancelWorkspace(store, id);
    const pending = cancelled.pendingCleanup?.length ?? 0;
    return `workspace ${id} detached (was ${workspace.branch})${pending > 0 ? ` — ${cancelled.pendingCleanup!.join('; ')}` : ''}`;
  }

  throw new WorkspaceError(`unknown workspace subcommand '${sub}' — create | attach | status | reconcile | cancel`, {
    sub,
  });
}

import { DeckError } from '../board/errors.ts';
import type { DocumentStore } from '../board/store.ts';
import { executionPath as boardExecutionPath, RecoveryRequiredError } from '../board/context.ts';
import type { Workspace } from '../projects/workspaces.ts';

export { RecoveryRequiredError };
export { boardExecutionPath as executionPath };

export interface ExecutionContext {
  canonicalPath: string;
  workspacePath: string;
  workspaceId: string | null;
}

export class WorkspaceStateError extends DeckError {}

export function contextFor(store: DocumentStore, workspace?: Workspace | null): ExecutionContext {
  const canonicalPath = store.projectPath;
  if (workspace === undefined || workspace === null) {
    return { canonicalPath, workspacePath: canonicalPath, workspaceId: null };
  }
  if (workspace.state !== 'attached') {
    throw new WorkspaceStateError(
      `workspace '${workspace.id}' is ${workspace.state} — reconcile or re-attach it before executing (deck workspace status)`,
      { workspaceId: workspace.id, state: workspace.state },
    );
  }
  return { canonicalPath, workspacePath: workspace.path ?? canonicalPath, workspaceId: workspace.id };
}

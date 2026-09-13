// The recovery ledger door (make-build-execution-trustworthy): list the
// unsettled operations fencing a checkout, and reconcile crashed/legacy work
// explicitly — confirm or clean, never a guessed takeover.
import type { ParsedArgs } from './args.ts';
import { UsageError, flagString } from './args.ts';
import { resolveProject } from './context.ts';
import { getStore } from '../core/projects/stores.ts';
import { listUnsettledOperations, reconcileOperation } from '../core/engine/ownership.ts';
import type { RunContext } from './main.ts';

export async function opsCommand(args: ParsedArgs, ctx: RunContext): Promise<string | number> {
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const [sub] = args.positionals;
  if (sub === undefined || sub === 'list') {
    const unsettled = listUnsettledOperations(store);
    if (unsettled.length === 0) return 'no unsettled operations — the checkout is free';
    return unsettled
      .map(
        (operation) =>
          `${operation.id}  ${operation.kind}  card ${operation.cardId}  ${operation.state}  ` +
          `owner ${operation.owner}  ${operation.checkout}`,
      )
      .join('\n');
  }
  if (sub === 'reconcile') {
    const operationId = args.positionals[1];
    const action =
      flagString(args.flags, 'confirm') !== undefined ? 'confirm' : flagString(args.flags, 'clean') !== undefined ? 'clean' : undefined;
    if (operationId === undefined || action === undefined) {
      throw new UsageError('usage: deck ops reconcile <operation-id> --confirm|--clean');
    }
    const operation = reconcileOperation(store, operationId, action);
    return `reconciled ${operation.id} → ${operation.state}`;
  }
  throw new UsageError('usage: deck ops [list] | deck ops reconcile <operation-id> --confirm|--clean');
}

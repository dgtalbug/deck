// The CLI face of the revert door (hold law): `deck revert <done-card-id>`
// materializes a NEW groomed revert-verb card from the archived merge;
// anything else falls through to the normal verb starter.
import type { ParsedArgs } from './args.ts';
import { UsageError } from './args.ts';
import { resolveProject } from './context.ts';
import { getStore } from '../core/projects/stores.ts';
import { openRevertDoor } from '../core/engine/revert.ts';
import type { ProjectRegistry } from '../core/projects/registry.ts';
import { startCommand } from './start.ts';
import type { Palette } from './color.ts';
import type { CliIo } from './main.ts';

export async function revertCommand(
  args: ParsedArgs,
  options: { registry: ProjectRegistry; cwd: string; io: CliIo; pal: Palette },
): Promise<string> {
  const id = args.positionals[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError('usage: deck revert <id>');
  }
  const project = resolveProject(options.registry, args, options.cwd);
  const store = await getStore(project.path);
  const card = store.getCard(id);
  if (!('verb' in card) || card.lane !== 'done') {
    return startCommand(args, options, 'revert');
  }
  const outcome = await openRevertDoor(store, project.path, id);
  const p = options.pal;
  return [
    `${p.color('primary', '♠')} ${p.bold(`revert door opened — ${outcome.card.title}`)}`,
    '',
    `  ${p.dim('card')}   ${outcome.card.id} → groomed`,
    `  ${p.dim('merge')}  ${outcome.mergeSha.slice(0, 10)} (${outcome.mergeSubject})`,
    `  ${p.dim('epic')}   ${outcome.card.epicId ?? '—'}`,
    '',
    `  ${p.dim('next')}   deck revert ${outcome.card.id} to start the reviewed revert`,
  ].join('\n');
}

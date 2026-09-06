// The shared start command every verb registers over (decision #8: the verb
// is data). The start output doubles as the build's context-pack header:
// card, branch, issue, and the deck next pointer.
import type { ParsedArgs } from './args.ts';
import { UsageError } from './args.ts';
import { resolveProject } from './context.ts';
import { getStore } from '../core/projects/stores.ts';
import { startVerb } from '../core/engine/verbs.ts';
import type { ProjectRegistry } from '../core/projects/registry.ts';
import type { VerbName } from '../core/board/types.ts';
import { renderHookWarnings } from '../core/engine/hooks.ts';
import { withSpinner } from './spin.ts';
import type { Palette } from './color.ts';
import type { CliIo } from './main.ts';

export async function startCommand(
  args: ParsedArgs,
  options: { registry: ProjectRegistry; cwd: string; io: CliIo; pal: Palette },
  verb: VerbName,
): Promise<string> {
  const id = args.positionals[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError(`usage: deck ${verb} <id>`);
  }
  const project = resolveProject(options.registry, args, options.cwd);
  const store = await getStore(project.path);
  const p = options.pal;
  return withSpinner(
    { isatty: Boolean(process.stdout.isTTY), dumb: Bun.env['TERM'] === 'dumb', io: options.io },
    `starting ${verb}…`,
    async () => {
      const outcome = await startVerb(store, id, verb);
      if (outcome.hookWarnings.length > 0) options.io.err(renderHookWarnings(outcome.hookWarnings).join('\n'));
      return [
        `${p.color('primary', '♠')} ${p.bold(`${verb} started — ${outcome.card.title}`)}`,
        '',
        `  ${p.dim('card')}   ${outcome.card.id} → active`,
        `  ${p.dim('branch')} ${outcome.branch} (checked out)`,
        `  ${p.dim('issue')}  ${outcome.queued ? 'pending (queued — gh offline)' : `#${outcome.issueNumber}`}`,
        '',
        `  ${p.dim('next')}   deck next`,
      ].join('\n');
    },
  );
}

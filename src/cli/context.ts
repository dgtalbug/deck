import type { ProjectInfo } from '../core/projects/types.ts';
import type { ProjectRegistry } from '../core/projects/registry.ts';
import { flagString, type ParsedArgs } from './args.ts';

// Project resolution order locked by the spec: --project flag >
// DECK_PROJECT env > registry entry whose path equals the cwd.
export class ProjectResolutionError extends Error {
  constructor(cwd: string) {
    super(
      `no deck project found for ${cwd} — pass --project <name>, set DECK_PROJECT, ` +
        `or run \`deck init\` in the project root`,
    );
    this.name = 'ProjectResolutionError';
  }
}

export function resolveProject(
  registry: ProjectRegistry,
  args: ParsedArgs,
  cwd: string,
): ProjectInfo {
  const byFlag = flagString(args.flags, 'project');
  if (byFlag !== undefined) {
    const project = registry.find(byFlag);
    if (project === undefined) throw new ProjectResolutionError(cwd);
    return project;
  }
  const byEnv = process.env['DECK_PROJECT'];
  if (byEnv !== undefined && byEnv.length > 0) {
    const project = registry.find(byEnv);
    if (project === undefined) throw new ProjectResolutionError(cwd);
    return project;
  }
  const byPath = registry.list().find((project) => project.path === cwd);
  if (byPath === undefined) throw new ProjectResolutionError(cwd);
  return byPath;
}

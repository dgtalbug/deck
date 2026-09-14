import { realpathSync } from 'node:fs';
import type { ProjectInfo } from '../core/projects/types.ts';
import type { ProjectRegistry } from '../core/projects/registry.ts';
import { flagString, type ParsedArgs } from './args.ts';

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
  if (byPath !== undefined) return byPath;
  // a worktree of a registered repository resolves to its canonical project —
  // the shared board lives there; execution still targets the assigned checkout
  const common = gitCommonDirOrNull(cwd);
  if (common !== null) {
    const owner = registry.list().find((project) => gitCommonDirOrNull(project.path) === common);
    if (owner !== undefined) return owner;
  }
  throw new ProjectResolutionError(cwd);
}

function gitCommonDirOrNull(cwd: string): string | null {
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) return null;
    return realpathSync(proc.stdout.toString().trim());
  } catch {
    return null;
  }
}

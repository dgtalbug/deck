import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD_DB_NAME } from '../board/store.ts';
import { runGit } from '../git/digest.ts';
import { runGh } from '../git/gh.ts';
import { AGENTS_END, AGENTS_START, agentsBlock, boardUrlFor } from './init.ts';
import type { ProjectRegistry } from './registry.ts';

// Read-only drift reporter (design D6): reuses the existing resolvers
// (registry, config port, git/gh runners, the init template constant).
// Never repairs — `deck init` does that.

export interface DoctorCheck {
  name: string;
  pass: boolean;
  detail?: string | undefined;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(1500) });
    return response.status < 500;
  } catch {
    return false;
  }
}

export async function runDoctor(
  registry: ProjectRegistry,
  projectPath: string,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const project = registry.find(projectPath);
  checks.push(
    project === undefined
      ? { name: 'registration', pass: false, detail: 'not registered — run `deck init`' }
      : { name: 'registration', pass: true, detail: project.name },
  );

  const boardUrl = await boardUrlFor(projectPath);
  const serverUp = await reachable(boardUrl);
  checks.push({
    name: 'server',
    pass: serverUp,
    detail: serverUp ? boardUrl : `no server on ${boardUrl} — start one with \`deck serve\``,
  });

  const dbPath = join(projectPath, '.deck', BOARD_DB_NAME);
  checks.push({
    name: 'board db',
    pass: existsSync(dbPath),
    detail: existsSync(dbPath) ? dbPath : 'missing — run `deck init`',
  });

  const git = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'], 3000);
  checks.push({
    name: 'git repo',
    pass: git.code === 0,
    detail: git.code === 0 ? undefined : 'not inside a git work tree',
  });

  const gh = await runGh(projectPath, ['--version'], 5000);
  checks.push({
    name: 'gh',
    pass: gh !== null && gh.code === 0,
    detail:
      gh === null
        ? 'no gh binary resolvable (DECK_GH_BIN, PATH, well-known locations)'
        : gh.code === 0
          ? undefined
          : `gh exited ${gh.code}`,
  });

  const agentsPath = join(projectPath, 'AGENTS.md');
  const agentsContent = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  const start = agentsContent.indexOf(AGENTS_START);
  const end = agentsContent.indexOf(AGENTS_END);
  let blockDetail: string | undefined;
  let blockPass = false;
  if (start < 0 || end <= start) {
    blockPass = false;
    blockDetail = 'managed block missing — run `deck init`';
  } else if (project === undefined) {
    blockPass = false;
    blockDetail = 'cannot verify block for an unregistered project';
  } else {
    const current = agentsContent.slice(start, end + AGENTS_END.length).trim();
    blockPass = current === agentsBlock(project.name, boardUrl).trim();
    if (!blockPass) blockDetail = 'block stale — run `deck init` to refresh it';
  }
  checks.push({ name: 'AGENTS.md block', pass: blockPass, detail: blockDetail });

  const dead = registry.list().filter((entry) => !existsSync(entry.path));
  checks.push({
    name: 'registry entries',
    pass: dead.length === 0,
    detail:
      dead.length === 0
        ? `${registry.list().length} registered`
        : `dead entries: ${dead.map((entry) => entry.name).join(', ')}`,
  });

  return checks;
}

export function renderDoctor(checks: DoctorCheck[]): string {
  return checks
    .map((check) => `${check.pass ? 'pass' : 'FAIL'}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`)
    .join('\n');
}

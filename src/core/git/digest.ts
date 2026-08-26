// Per-project git facts (v0.2.0, local-only by locked decision): read-only
// git plumbing run in the project's registered path, each bounded by a
// timeout; any failure collapses the whole digest to { repo: false } so the
// UI can hide the section instead of erroring. No .git file parsing
// (worktrees/packed-refs fragility) and no gh in this pass.

export interface GitCommit {
  sha: string;
  subject: string;
}

export interface GitDigest {
  repo: boolean;
  branch?: string;
  head?: string;
  dirtyCount?: number;
  ahead?: number;
  behind?: number;
  recent: GitCommit[];
  origin?: string;
}

const TIMEOUT_MS = 2000;

async function git(projectPath: string, args: string[]): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(['git', ...args], {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    });
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0 ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

function parseRecent(log: string | undefined): GitCommit[] {
  if (log === undefined || log === '') return [];
  return log
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const space = line.indexOf(' ');
      return space === -1
        ? { sha: line, subject: '' }
        : { sha: line.slice(0, space), subject: line.slice(space + 1) };
    });
}

export async function gitDigest(projectPath: string): Promise<GitDigest> {
  const [branch, head, status, counts, log, origin] = await Promise.all([
    git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(projectPath, ['rev-parse', '--short', 'HEAD']),
    git(projectPath, ['status', '--porcelain']),
    git(projectPath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    git(projectPath, ['log', '-5', '--oneline', '--no-decorate']),
    git(projectPath, ['remote', 'get-url', 'origin']),
  ]);
  if (branch === undefined || head === undefined) {
    return { repo: false, recent: [] };
  }
  const dirtyCount = status === undefined || status === '' ? 0 : status.split('\n').filter((line) => line !== '').length;
  let ahead: number | undefined;
  let behind: number | undefined;
  const match = /^(\d+)\s+(\d+)$/.exec(counts ?? '');
  if (match !== null) {
    behind = Number(match[1]);
    ahead = Number(match[2]);
  }
  return {
    repo: true,
    branch,
    head,
    dirtyCount,
    ...(ahead !== undefined && behind !== undefined ? { ahead, behind } : {}),
    recent: parseRecent(log),
    ...(origin !== undefined && origin !== '' ? { origin } : {}),
  };
}

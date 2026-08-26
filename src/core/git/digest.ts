// Per-project git facts (v0.2.0 digest, extended in v0.3.0): read-only git
// plumbing run in the project's registered path, each bounded by a timeout;
// any failure collapses the whole digest to { repo: false } so the UI can
// hide the section instead of erroring. No .git file parsing
// (worktrees/packed-refs fragility). The write side lives in ops.ts and
// shares runGit (design D1).

import { runGh } from './gh.ts';

export interface GitCommit {
  sha: string;
  subject: string;
}

export interface GhStatus {
  available: boolean;
  account?: string;
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
  branches?: string[];
  stashCount?: number;
  gh?: GhStatus;
}

const TIMEOUT_MS = 2000;
const GH_TIMEOUT_MS = 5000;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// The one subprocess runner (design D1): argument arrays — never a shell, so
// injection is structurally impossible — stdin ignored, stdout+stderr
// captured, killed on timeout (exit code above 128, like a signal death).
export async function runCommand(
  bin: string,
  projectPath: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<RunResult> {
  const proc = Bun.spawn([bin, ...args], {
    cwd: projectPath,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    // explicit env copy: Bun snapshots process.env at startup otherwise,
    // which would ignore test-time PATH manipulation (gh stubs)
    env: { ...process.env },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

export function runGit(projectPath: string, args: string[], timeoutMs = 10_000): Promise<RunResult> {
  return runCommand('git', projectPath, args, timeoutMs);
}

async function git(projectPath: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<string | undefined> {
  try {
    const { code, stdout } = await runGit(projectPath, args, timeoutMs);
    return code === 0 ? stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

// gh availability (design D4): probed per digest, never cached at boot; a
// missing binary or non-zero exit both collapse to { available: false }.
async function ghStatus(projectPath: string): Promise<GhStatus> {
  const result = await runGh(projectPath, ['auth', 'status'], GH_TIMEOUT_MS);
  if (result === null || result.code !== 0) return { available: false };
  const match = /account\s+([^\s(]+)/.exec(`${result.stdout}\n${result.stderr}`);
  return match === null ? { available: true } : { available: true, account: match[1] };
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
  const [branch, head, status, counts, log, origin, branches, stashList, gh] = await Promise.all([
    git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(projectPath, ['rev-parse', '--short', 'HEAD']),
    git(projectPath, ['status', '--porcelain']),
    git(projectPath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    git(projectPath, ['log', '-5', '--oneline', '--no-decorate']),
    git(projectPath, ['remote', 'get-url', 'origin']),
    git(projectPath, ['branch', '--format=%(refname:short)']),
    git(projectPath, ['stash', 'list']),
    ghStatus(projectPath),
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
  const stashCount = stashList === undefined || stashList === '' ? 0 : stashList.split('\n').filter((line) => line !== '').length;
  return {
    repo: true,
    branch,
    head,
    dirtyCount,
    ...(ahead !== undefined && behind !== undefined ? { ahead, behind } : {}),
    recent: parseRecent(log),
    ...(origin !== undefined && origin !== '' ? { origin } : {}),
    branches: branches === undefined || branches === '' ? [] : branches.split('\n'),
    stashCount,
    gh,
  };
}

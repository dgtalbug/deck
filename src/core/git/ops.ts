// Guarded git write operations (v0.3.0, design D2/D3/D7): every mutation
// runs through runGit (arg arrays, timeouts, captured output), guards live
// here and are mirrored in GitPage. Never a force/rewrite flag; a failed
// merge auto-aborts so the repo is never left mid-merge. Each op returns
// git's captured output; refusals throw the typed errors from errors.ts.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from './digest.ts';
import { runGh } from './gh.ts';
import { GitOpError, InvalidBranchError, GhUnavailableError } from './errors.ts';

const LOCAL_TIMEOUT_MS = 10_000;
const NETWORK_TIMEOUT_MS = 60_000;

export interface GitOpResult {
  output: string;
}

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function validateBranchName(name: string): void {
  if (
    name.length > 100 ||
    !BRANCH_NAME.test(name) ||
    name.includes('..') ||
    name.endsWith('/') ||
    name.endsWith('.lock') ||
    name.includes('@{')
  ) {
    throw new InvalidBranchError(name);
  }
}

async function output(projectPath: string, args: string[], timeoutMs = LOCAL_TIMEOUT_MS): Promise<string> {
  const { code, stdout, stderr } = await runGit(projectPath, args, timeoutMs);
  if (code !== 0) {
    const combined = `${stdout}${stderr}`.trim();
    throw new GitOpError(args[0] ?? 'git', `exit ${code}`, combined);
  }
  return `${stdout}${stderr}`.trim();
}

async function assertCleanTree(projectPath: string, operation: string): Promise<void> {
  const status = await runGit(projectPath, ['status', '--porcelain']);
  if (status.code !== 0) {
    throw new GitOpError('status', `exit ${status.code}`, `${status.stdout}${status.stderr}`.trim());
  }
  const dirty = status.stdout.trim();
  if (dirty !== '') {
    throw new GitOpError(operation, 'working tree is not clean', dirty);
  }
}

async function currentBranch(projectPath: string): Promise<string> {
  const { code, stdout, stderr } = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (code !== 0) throw new GitOpError('rev-parse', `exit ${code}`, `${stdout}${stderr}`.trim());
  return stdout.trim();
}

async function branchExists(projectPath: string, name: string): Promise<boolean> {
  const { code } = await runGit(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  return code === 0;
}

function assertRepo(result: { code: number; stdout: string; stderr: string }, operation: string): void {
  if (result.code !== 0) {
    throw new GitOpError(operation, `exit ${result.code}`, `${result.stdout}${result.stderr}`.trim());
  }
}

// gh feature detection per request (design D4): absent binary or failed auth
// both throw GhUnavailableError — no partial degradation inside an operation.
async function requireGh(projectPath: string): Promise<void> {
  const result = await runGh(projectPath, ['auth', 'status']);
  if (result === null) throw new GhUnavailableError();
  if (result.code !== 0) {
    throw new GhUnavailableError(`${result.stdout}${result.stderr}`.trim());
  }
}

// --- branches ---

export async function createBranch(
  projectPath: string,
  input: { name: string; base?: string | undefined; checkout?: boolean | undefined },
): Promise<GitOpResult> {
  validateBranchName(input.name);
  if (input.base !== undefined) {
    validateBranchName(input.base);
    const base = await runGit(projectPath, ['rev-parse', '--verify', '--quiet', input.base]);
    if (base.code !== 0) throw new GitOpError('branch', `base '${input.base}' not found`, '');
  }
  const args = input.checkout === true
    ? ['switch', '-c', input.name, ...(input.base !== undefined ? [input.base] : [])]
    : ['branch', input.name, ...(input.base !== undefined ? [input.base] : [])];
  return { output: await output(projectPath, args) };
}

export async function switchBranch(projectPath: string, name: string): Promise<GitOpResult> {
  validateBranchName(name);
  await assertCleanTree(projectPath, 'switch');
  if (!(await branchExists(projectPath, name))) {
    throw new GitOpError('switch', `branch '${name}' not found`, '');
  }
  return { output: await output(projectPath, ['switch', name]) };
}

export async function deleteBranch(projectPath: string, name: string): Promise<GitOpResult> {
  validateBranchName(name);
  const current = await currentBranch(projectPath);
  if (current === name) {
    throw new GitOpError('branch', 'cannot delete the current branch', '');
  }
  if (!(await branchExists(projectPath, name))) {
    throw new GitOpError('branch', `branch '${name}' not found`, '');
  }
  // -d only — git itself refuses unmerged branches; deck never -D's.
  return { output: await output(projectPath, ['branch', '-d', name]) };
}

// --- working tree ---

export async function commitAll(projectPath: string, message?: string): Promise<GitOpResult> {
  const add = await runGit(projectPath, ['add', '-A']);
  assertRepo(add, 'add');
  const text = message === undefined || message.trim() === '' ? 'wip(deck)' : message.trim();
  return { output: await output(projectPath, ['commit', '-m', text]) };
}

export async function undoLastCommit(projectPath: string): Promise<GitOpResult> {
  const hasPrevious = await runGit(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD~1']);
  if (hasPrevious.code !== 0) {
    throw new GitOpError('reset', 'no previous commit to undo', '');
  }
  return { output: await output(projectPath, ['reset', '--soft', 'HEAD~1']) };
}

export async function stashPush(projectPath: string, message?: string): Promise<GitOpResult> {
  const args = ['stash', 'push', ...(message !== undefined && message.trim() !== '' ? ['-m', message.trim()] : [])];
  return { output: await output(projectPath, args) };
}

export async function stashPop(projectPath: string): Promise<GitOpResult> {
  await assertCleanTree(projectPath, 'stash pop');
  const list = await runGit(projectPath, ['stash', 'list']);
  assertRepo(list, 'stash');
  if (list.stdout.trim() === '') {
    throw new GitOpError('stash pop', 'no stash entries', '');
  }
  const pop = await runGit(projectPath, ['stash', 'pop']);
  if (pop.code !== 0) {
    // Documented exception (design D3): git keeps the stash entry; the tree
    // may hold conflict markers and deck never reset --hard's — surface the
    // output verbatim instead.
    throw new GitOpError('stash pop', 'conflict while applying the stash', `${pop.stdout}${pop.stderr}`.trim());
  }
  return { output: `${pop.stdout}${pop.stderr}`.trim() };
}

// --- merge ---

export async function mergeBranch(
  projectPath: string,
  from: string,
  opts: { noFf?: boolean | undefined; message?: string | undefined } = {},
): Promise<GitOpResult> {
  validateBranchName(from);
  await assertCleanTree(projectPath, 'merge');
  const current = await currentBranch(projectPath);
  if (current === from) {
    throw new GitOpError('merge', `cannot merge '${from}' into itself`, '');
  }
  if (!(await branchExists(projectPath, from))) {
    throw new GitOpError('merge', `branch '${from}' not found`, '');
  }
  const merge = await runGit(projectPath, [
    'merge',
    ...(opts.message !== undefined && opts.message !== '' ? ['-m', opts.message] : ['--no-edit']),
    ...(opts.noFf === true ? ['--no-ff'] : []),
    from,
  ]);
  if (merge.code !== 0) {
    await runGit(projectPath, ['merge', '--abort']); // never leave a repo mid-merge
    throw new GitOpError('merge', 'conflict — merge aborted, tree restored', `${merge.stdout}${merge.stderr}`.trim());
  }
  return { output: `${merge.stdout}${merge.stderr}`.trim() };
}

// --- remote ---

export async function fetchRemote(projectPath: string): Promise<GitOpResult> {
  return { output: await output(projectPath, ['fetch', '--prune'], NETWORK_TIMEOUT_MS) };
}

export async function pullRemote(projectPath: string): Promise<GitOpResult> {
  await assertCleanTree(projectPath, 'pull');
  return { output: await output(projectPath, ['pull', '--ff-only'], NETWORK_TIMEOUT_MS) };
}

export async function pushRemote(projectPath: string): Promise<GitOpResult> {
  return { output: await output(projectPath, ['push', '-u', 'origin', 'HEAD'], NETWORK_TIMEOUT_MS) };
}

// --- pull requests via gh ---

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  url: string;
  isDraft: boolean;
}

export async function listPullRequests(projectPath: string): Promise<PullRequest[]> {
  await requireGh(projectPath);
  const result = await runGh(projectPath, [
    'pr', 'list', '--json', 'number,title,headRefName,url,isDraft', '--limit', '20',
  ]);
  if (result === null) throw new GhUnavailableError();
  const { code, stdout, stderr } = result;
  if (code !== 0) {
    throw new GitOpError('pr list', `exit ${code}`, `${stdout}${stderr}`.trim());
  }
  try {
    return JSON.parse(stdout) as PullRequest[];
  } catch {
    throw new GitOpError('pr list', 'unparseable gh output', stdout.trim());
  }
}

// Merged PRs feed the project timeline — mergedAt is the event timestamp.
export interface MergedPullRequest {
  number: number;
  title: string;
  mergedAt: string;
  url: string;
  // merge commit — gh returns {oid}; the timeline dedups git commits against it
  mergeCommit?: { oid: string } | undefined;
}

export async function listMergedPullRequests(projectPath: string, limit = 30): Promise<MergedPullRequest[]> {
  await requireGh(projectPath);
  const result = await runGh(projectPath, [
    'pr', 'list', '--state', 'merged', '--json', 'number,title,mergedAt,url,mergeCommit', '--limit', String(limit),
  ]);
  if (result === null) throw new GhUnavailableError();
  const { code, stdout, stderr } = result;
  if (code !== 0) {
    throw new GitOpError('pr list --state merged', `exit ${code}`, `${stdout}${stderr}`.trim());
  }
  try {
    return JSON.parse(stdout) as MergedPullRequest[];
  } catch {
    throw new GitOpError('pr list --state merged', 'unparseable gh output', stdout.trim());
  }
}

// Recent commits feed the project timeline — local git log, no network.
// The field separator (\x1f) cannot appear in a formatted log line.
export interface RecentCommit {
  sha: string;
  shortSha: string;
  subject: string;
  date: string;
}

export async function listRecentCommits(projectPath: string, limit = 50): Promise<RecentCommit[]> {
  const SEP = '\x1f';
  const result = await runGit(
    projectPath,
    ['log', `-n`, String(limit), `--pretty=format:%H${SEP}%h${SEP}%s${SEP}%cI`],
    LOCAL_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new GitOpError('log', `exit ${result.code}`, `${result.stdout}${result.stderr}`.trim());
  }
  return result.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, shortSha, subject, date] = line.split(SEP);
      return { sha: sha ?? '', shortSha: shortSha ?? '', subject: subject ?? '', date: date ?? '' };
    })
    .filter((commit) => commit.sha !== '');
}

export async function createPullRequest(
  projectPath: string,
  input: { title: string; base?: string | undefined; draft?: boolean | undefined; body?: string | undefined },
): Promise<{ url: string }> {
  await requireGh(projectPath);
  // Spec-generated bodies can be long markdown — pass via a temp file so the
  // content never sits in an argv slot (--body-file, mirroring issue ops).
  let bodyFile: string | undefined;
  if (input.body !== undefined && input.body !== '') {
    const dir = mkdtempSync(join(tmpdir(), 'deck-pr-'));
    bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, input.body, 'utf8');
  }
  try {
    const result = await runGh(projectPath, [
      'pr', 'create',
      '--title', input.title,
      ...(bodyFile !== undefined ? ['--body-file', bodyFile] : ['--body', '']),
      ...(input.base !== undefined && input.base !== '' ? ['--base', input.base] : []),
      ...(input.draft === true ? ['--draft'] : []),
    ]);
    if (result === null) throw new GhUnavailableError();
    const { code, stdout, stderr } = result;
    if (code !== 0) {
      throw new GitOpError('pr create', `exit ${code}`, `${stdout}${stderr}`.trim());
    }
    const url = stdout.trim().split('\n').pop() ?? '';
    if (url === '') {
      throw new GitOpError('pr create', 'gh printed no PR URL', stderr.trim());
    }
    return { url };
  } finally {
    if (bodyFile !== undefined) rmSync(join(bodyFile, '..'), { recursive: true, force: true });
  }
}

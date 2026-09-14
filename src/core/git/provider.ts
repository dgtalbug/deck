// Provider-facing git surface (E05): guarded local integration and fresh PR
// observation/search — the seams delivery.ts and archive.ts read. Split from
// ops.ts (400-line law); helpers come from ops.ts, ops.ts re-exports the
// public names so callers keep their imports.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from './digest.ts';
import { runGh } from './gh.ts';
import { GhUnavailableError, GitOpError } from './errors.ts';
import { assertCleanTree, branchExists, currentBranch, output, validateBranchName } from './ops.ts';

// --- guarded local integration (E05 DECK-ARCH-014, solo delivery) ------------

export interface LocalIntegration {
  mergedSha: string;
  base: string;
  branch: string;
  output: string;
}

// Explicit solo/local integration: fast-forward-safe merge of the owned
// feature branch into the local default branch under clean-tree and checkout
// guards. NO push, NO provider call — solo completion claims local delivery
// only. A failed merge auto-aborts (never a repo mid-merge) and unrelated
// work is preserved (nothing is ever forced).
export async function integrateLocally(
  projectPath: string,
  branch: string,
  base: string,
  opts: { message?: string | undefined } = {},
): Promise<LocalIntegration> {
  validateBranchName(branch);
  validateBranchName(base);
  await assertCleanTree(projectPath, 'local integration');
  const current = await currentBranch(projectPath);
  if (current !== branch) {
    throw new GitOpError('local integration', `checkout is on '${current}' but the card owns '${branch}'`, '');
  }
  if (!(await branchExists(projectPath, base))) {
    throw new GitOpError('local integration', `base branch '${base}' not found`, '');
  }
  await output(projectPath, ['switch', base]);
  const merge = await runGit(projectPath, [
    'merge',
    '--no-ff',
    ...(opts.message !== undefined && opts.message !== '' ? ['-m', opts.message] : ['--no-edit']),
    branch,
  ]);
  if (merge.code !== 0) {
    await runGit(projectPath, ['merge', '--abort']); // restore base, preserve the branch
    await output(projectPath, ['switch', branch]);
    throw new GitOpError('local integration', 'conflict — merge aborted, base restored', `${merge.stdout}${merge.stderr}`.trim());
  }
  const sha = await runGit(projectPath, ['rev-parse', 'HEAD'], 5000);
  return {
    mergedSha: sha.stdout.trim(),
    base,
    branch,
    output: `${merge.stdout}${merge.stderr}`.trim(),
  };
}

export async function editPullRequestBody(
  projectPath: string,
  number: number,
  body: string,
  provider?: { run(args: string[], timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string } | null> } | undefined,
): Promise<void> {
  const runner = provider ?? { run: (args, timeoutMs) => runGh(projectPath, args, timeoutMs) };
  const dir = mkdtempSync(join(tmpdir(), 'deck-pr-'));
  const bodyFile = join(dir, 'body.md');
  writeFileSync(bodyFile, body, 'utf8');
  try {
    const result = await runner.run(['pr', 'edit', String(number), '--body-file', bodyFile], 30_000);
    if (result === null) throw new GhUnavailableError();
    if (result.code !== 0) {
      throw new GitOpError('pr edit', `exit ${result.code}`, `${result.stdout}${result.stderr}`.trim());
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- E05 provider-intent lookup and observed state (DECK-ARCH-013/014) -------
//
// Injectable seam as in issues.ts: the trailing `provider` parameter lets
// tests inject a fake provider; the default rides runGh. No new provider
// dependencies.

export interface PrRef {
  number: number;
  title: string;
  state: string;
  url: string;
  headRefName?: string | undefined;
  headRefOid?: string | undefined;
  baseRefName?: string | undefined;
}

export interface ProviderCheck {
  name: string | null;
  // CheckRun conclusion/status or StatusContext state, lower-cased.
  state: string;
}

export interface PullRequestObservation {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'merged' | 'closed';
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergeCommit: { oid: string } | null;
  checks: ProviderCheck[];
  // 'approved' | 'review_required' | … (lower-cased), null when no reviews.
  reviewDecision: string | null;
}

const PR_VIEW_FIELDS = 'number,title,url,state,headRefName,headRefOid,baseRefName,mergeCommit,statusCheckRollup,reviewDecision';

function mapRollup(rollup: unknown): ProviderCheck[] {
  if (!Array.isArray(rollup)) return [];
  return rollup.map((entry) => {
    const item = entry as { name?: string; context?: string; status?: string; conclusion?: string; state?: string };
    return {
      name: item.name ?? item.context ?? null,
      state: (item.conclusion ?? item.state ?? item.status ?? 'unknown').toLowerCase(),
    };
  });
}

export async function viewPullRequest(
  projectPath: string,
  number: number,
  provider?: { run(args: string[], timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string } | null> } | undefined,
): Promise<PullRequestObservation> {
  const runner = provider ?? { run: (args, timeoutMs) => runGh(projectPath, args, timeoutMs) };
  const result = await runner.run(['pr', 'view', String(number), '--json', PR_VIEW_FIELDS], 30_000);
  if (result === null) throw new GhUnavailableError();
  if (result.code !== 0) {
    throw new GitOpError('pr view', `exit ${result.code}`, `${result.stdout}${result.stderr}`.trim());
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      number: number;
      title: string;
      url: string;
      state: string;
      headRefName: string;
      headRefOid: string;
      baseRefName: string;
      mergeCommit?: { oid: string } | null;
      statusCheckRollup?: unknown;
      reviewDecision?: string | null;
    };
    const state = parsed.state.toLowerCase();
    if (state !== 'open' && state !== 'merged' && state !== 'closed') {
      throw new GitOpError('pr view', `unexpected state '${parsed.state}'`, result.stdout.trim());
    }
    return {
      number: parsed.number,
      title: parsed.title,
      url: parsed.url,
      state,
      headRefName: parsed.headRefName,
      headRefOid: parsed.headRefOid,
      baseRefName: parsed.baseRefName,
      mergeCommit: parsed.mergeCommit ?? null,
      checks: mapRollup(parsed.statusCheckRollup),
      reviewDecision: parsed.reviewDecision ? parsed.reviewDecision.toLowerCase() : null,
    };
  } catch (error) {
    if (error instanceof GitOpError) throw error;
    throw new GitOpError('pr view', 'unparseable gh output', result.stdout.trim());
  }
}

// Bounded paginated marker lookup over open+recently-closed PRs.
export async function searchPullRequestsByMarker(
  projectPath: string,
  marker: string,
  options: { maxPages?: number | undefined; state?: 'open' | 'merged' | 'closed' | 'all' | undefined; provider?: { run(args: string[], timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string } | null> } | undefined } = {},
): Promise<PrRef[]> {
  const runner = options.provider ?? { run: (args, timeoutMs) => runGh(projectPath, args, timeoutMs) };
  const maxPages = options.maxPages ?? 5;
  const out: PrRef[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await runner.run([
      'pr', 'list',
      ...(options.state !== undefined ? ['--state', options.state] : []),
      '--search', marker,
      '--json', 'number,title,state,url,headRefName,headRefOid,baseRefName',
      '--limit', '100', '--page', String(page),
    ], 30_000);
    if (result === null) throw new GhUnavailableError();
    if (result.code !== 0) {
      throw new GitOpError('pr list --search', `exit ${result.code}`, `${result.stdout}${result.stderr}`.trim());
    }
    let parsed: PrRef[];
    try {
      parsed = JSON.parse(result.stdout) as PrRef[];
    } catch {
      throw new GitOpError('pr list --search', 'unparseable gh output', result.stdout.trim());
    }
    out.push(...parsed);
    if (parsed.length < 100) break;
  }
  return out;
}

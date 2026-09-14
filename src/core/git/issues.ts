import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGh } from './gh.ts';
import { GhUnavailableError, GitOpError } from './errors.ts';
import type { Lane } from '../board/types.ts';

export const LANE_LABELS: readonly Lane[] = ['todo', 'groomed', 'active', 'verify', 'done'];

interface GhRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function issueOp(
  projectPath: string,
  operation: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<GhRun> {
  const result = await runGh(projectPath, ['issue', ...args], timeoutMs);
  if (result === null) throw new GhUnavailableError();
  if (result.code !== 0) {
    throw new GitOpError(`issue ${operation}`, `exit ${result.code}`, `${result.stdout}${result.stderr}`.trim());
  }
  return result;
}

function bodyFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'deck-issue-'));
  const file = join(dir, 'body.md');
  writeFileSync(file, body, 'utf8');
  return file;
}

export interface IssueView {
  number: number;
  state: 'open' | 'closed';
  labels: string[];
  url: string;
}

export async function createIssue(
  projectPath: string,
  input: { title: string; body: string; label?: Lane | undefined },
): Promise<{ number: number; url: string }> {
  const file = bodyFile(input.body);
  try {
    let result: GhRun;
    try {
      const labelArgs = input.label === undefined ? [] : ['--label', input.label];
      result = await issueOp(projectPath, 'create', [
        'create', '--title', input.title, '--body-file', file, ...labelArgs,
      ]);
    } catch (error) {
      if (error instanceof GitOpError && input.label !== undefined && /label/i.test(error.details['output'] as string ?? '')) {
        result = await issueOp(projectPath, 'create', [
          'create', '--title', input.title, '--body-file', file,
        ]);
      } else {
        throw error;
      }
    }
    const url = result.stdout.trim().split('\n').pop() ?? '';
    const number = Number(url.match(/issues\/(\d+)/)?.[1]);
    if (!Number.isInteger(number) || number <= 0) {
      throw new GitOpError('issue create', 'gh printed no issue URL', result.stderr.trim());
    }
    return { number, url };
  } finally {
    rmSync(join(file, '..'), { recursive: true, force: true });
  }
}

export async function editIssueBody(projectPath: string, number: number, body: string): Promise<void> {
  const file = bodyFile(body);
  try {
    await issueOp(projectPath, 'edit', ['edit', String(number), '--body-file', file]);
  } finally {
    rmSync(join(file, '..'), { recursive: true, force: true });
  }
}

export async function closeIssue(projectPath: string, number: number): Promise<void> {
  await issueOp(projectPath, 'close', ['close', String(number)]);
}

export async function viewIssue(projectPath: string, number: number): Promise<IssueView> {
  const result = await issueOp(projectPath, 'view', [
    'view', String(number), '--json', 'number,state,labels,url',
  ]);
  try {
    const parsed = JSON.parse(result.stdout) as { number: number; state: string; labels: { name: string }[]; url: string };
    const state = parsed.state.toLowerCase();
    if (state !== 'open' && state !== 'closed') {
      throw new GitOpError('issue view', `unexpected state '${parsed.state}'`, result.stdout.trim());
    }
    return {
      number: parsed.number,
      state,
      labels: parsed.labels.map((label) => label.name),
      url: parsed.url,
    };
  } catch (error) {
    if (error instanceof GitOpError) throw error;
    throw new GitOpError('issue view', 'unparseable gh output', result.stdout.trim());
  }
}

export async function setLaneLabel(projectPath: string, number: number, lane: Lane): Promise<void> {
  const view = await viewIssue(projectPath, number);
  const currentLanes = view.labels.filter((label): label is Lane =>
    (LANE_LABELS as readonly string[]).includes(label),
  );
  const stale = currentLanes.filter((label) => label !== lane);
  const removeArgs = stale.flatMap((label) => ['--remove-label', label]);
  const needsAdd = !view.labels.includes(lane);
  if (stale.length === 0 && !needsAdd) return;
  const args = ['edit', String(number), ...removeArgs];
  if (needsAdd) {
    const ensure = await runGh(projectPath, ['label', 'create', lane, '--force']);
    if (ensure === null) throw new GhUnavailableError();
    if (ensure.code !== 0) {
      throw new GitOpError('label create', `exit ${ensure.code}`, `${ensure.stdout}${ensure.stderr}`.trim());
    }
    args.push('--add-label', lane);
  }
  await issueOp(projectPath, 'edit labels', args);
}

export interface ProviderRunner {
  run(args: string[], timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string } | null>;
}

export function defaultProviderRunner(projectPath: string): ProviderRunner {
  return {
    async run(args, timeoutMs) {
      return runGh(projectPath, args, timeoutMs);
    },
  };
}

export interface IssueRef {
  number: number;
  title: string;
  state: string;
  url: string;
}

export async function searchIssuesByMarker(
  projectPath: string,
  marker: string,
  options: { maxPages?: number | undefined; provider?: ProviderRunner | undefined } = {},
): Promise<IssueRef[]> {
  const provider = options.provider ?? defaultProviderRunner(projectPath);
  const maxPages = options.maxPages ?? 5;
  const out: IssueRef[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await provider.run([
      'issue', 'list', '--search', marker, '--json', 'number,title,state,url',
      '--limit', '100', '--page', String(page),
    ], 30_000);
    if (result === null) throw new GhUnavailableError();
    if (result.code !== 0) {
      throw new GitOpError('issue list --search', `exit ${result.code}`, `${result.stdout}${result.stderr}`.trim());
    }
    let parsed: IssueRef[];
    try {
      parsed = JSON.parse(result.stdout) as IssueRef[];
    } catch {
      throw new GitOpError('issue list --search', 'unparseable gh output', result.stdout.trim());
    }
    out.push(...parsed);
    if (parsed.length < 100) break;
  }
  return out;
}

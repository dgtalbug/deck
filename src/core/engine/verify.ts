// Verify + review + archive tail (verify-review-archive, P1c — the last
// openspec change): a deterministic converge driver whose ONLY writer is
// the existing applyVerifyResult, a lean single-pass review gate that
// attacks the diff and blocks archive, and a best-effort archive tail
// (changelog + tagged gh release). No AI anywhere in deck's loop — the
// agent brings the intelligence; deck computes and enforces.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeckError } from '../board/errors.ts';
import { applyVerifyResult } from '../board/verify.ts';
import { newestSpecVersion } from '../board/specstore.ts';
import { getIssueMap } from '../board/specstore.ts';
import type { DocumentStore } from '../board/store.ts';
import type { VerbItem } from '../board/types.ts';
import { runGit } from '../git/digest.ts';
import { runGh } from '../git/gh.ts';
import { branchFor } from './slug.ts';
import { HookEvent, runHooks, type HookWarning } from './hooks.ts';

// --- deterministic gap computation -------------------------------------------

export interface Gap {
  requirement?: string | undefined;
  taskTitle: string;
  evidence: string;
}

export function parseRequirementNames(markdown: string): string[] {
  const names: string[] = [];
  for (const match of markdown.matchAll(/^### (?:(?:ADDED|MODIFIED|REMOVED|RENAMED): )?Requirement: (.+)$/gm)) {
    names.push(match[1]!.trim());
  }
  return names;
}

function kebab(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 4)
    .join('-');
}

function taskReferencesRequirement(taskTitle: string, requirement: string): boolean {
  const keyWords = requirement
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);
  if (keyWords.length === 0) return false;
  const title = taskTitle.toLowerCase();
  const hits = keyWords.filter((word) => title.includes(word)).length;
  return hits >= Math.max(1, Math.ceil(keyWords.length / 2));
}

function testFileExists(projectPath: string, slug: string): boolean {
  const tests = join(projectPath, 'tests');
  if (!existsSync(tests) || slug.length === 0) return false;
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  return walk(tests).some((file) => file.includes(slug));
}

// Pure data out — no mutations, no network. (a) unchecked tasks enumerate as
// gaps; (b) a spec requirement with neither a referencing task nor a paired
// test file in the worktree is itself a gap.
export function computeGaps(store: DocumentStore, id: string): Gap[] {
  const card = store.getVerbItem(id); // typed 404 for non-verb ids
  if (card.lane !== 'verify') {
    throw new DeckError(`card ${id} is in ${card.lane} — verification computes on verify-lane cards`, {
      cardId: id,
      lane: card.lane,
    });
  }
  const gaps: Gap[] = card.tasks.filter((task) => !task.done).map((task) => ({
    taskTitle: task.title,
    evidence: task.id,
  }));
  const version = newestSpecVersion(store, id);
  if (version !== undefined) {
    for (const requirement of parseRequirementNames(version.markdown)) {
      const referenced = card.tasks.some((task) => taskReferencesRequirement(task.title, requirement));
      const pairedTest = testFileExists(store.projectPath, kebab(requirement));
      if (!referenced && !pairedTest) {
        gaps.push({
          requirement,
          taskTitle: `provide evidence for "${requirement}"`,
          evidence: 'none',
        });
      }
    }
  }
  return gaps;
}

// --- converge loop -----------------------------------------------------------

export interface ConvergeOutcome {
  result: 'clean' | 'gaps';
  gaps: Gap[];
  card: VerbItem;
  hookWarnings: HookWarning[];
}

// The driver computes, then hands the outcome to applyVerifyResult — the
// ONLY mutation path (gaps → active + tasks appended; clean → done).
export async function runVerification(store: DocumentStore, id: string): Promise<ConvergeOutcome> {
  const gaps = computeGaps(store, id);
  const result = gaps.length === 0 ? 'clean' as const : 'gaps' as const;
  applyVerifyResult(store, id, result, gaps.map((gap) => gap.taskTitle));
  const card = store.getVerbItem(id);
  // onVerifyResult fires on both outcomes (core, so both doors fire it).
  const hookWarnings = await runHooks(store.projectPath, HookEvent.VerifyResult, {
    event: HookEvent.VerifyResult,
    cardId: id,
    verb: card.verb,
    lane: card.lane,
    branch: branchFor(card, card.verb),
    issueNumber: getIssueMap(store, id)?.issueNumber ?? null,
    result,
    timestamp: new Date().toISOString(),
  });
  return { result, gaps, card, hookWarnings };
}

// --- the lean review gate ------------------------------------------------------

export interface Finding {
  risk: string;
  violates: string;
}

async function diffFiles(projectPath: string, base: string, head: string): Promise<string[]> {
  const diff = await runGit(projectPath, ['diff', '--name-only', `${base}...${head}`], 10_000);
  if (diff.code !== 0) return [];
  return diff.stdout.split('\n').filter((line) => line.trim().length > 0);
}

// Single pass, deterministic for a given diff: checklist completeness,
// requirement↔paired-test coverage in the diff, and the three laws' cheap
// proxies (no unjustified deps, ceremony scale). Danger-toned rendering is
// the CLI's job; this is pure data.
export async function reviewGate(store: DocumentStore, id: string): Promise<Finding[]> {
  const card = store.getVerbItem(id);
  if (card.lane !== 'active' && card.lane !== 'verify') {
    throw new DeckError(`card ${id} is in ${card.lane} — review runs on active or verify verb items`, {
      cardId: id,
      lane: card.lane,
    });
  }
  const findings: Finding[] = [];
  for (const task of card.tasks.filter((task) => !task.done)) {
    findings.push({
      risk: `task "${task.title}" is unchecked — the change claims done it does not show`,
      violates: 'checklist completeness',
    });
  }
  const version = newestSpecVersion(store, id);
  if (version !== undefined) {
    const branch = branchFor(card, card.verb);
    const base = await defaultBranchOf(store.projectPath);
    const files = await diffFiles(store.projectPath, base, branch);
    for (const requirement of parseRequirementNames(version.markdown)) {
      const slug = kebab(requirement);
      const paired = files.find((file) => file.includes(slug));
      if (paired === undefined) {
        findings.push({
          risk: `requirement "${requirement}" has no paired file in the diff (${slug} not touched)`,
          violates: requirement,
        });
      }
    }
    const deps = files.filter((file) => file === 'package.json' || file === 'bun.lock' || file === 'bun.lockb');
    const depTask = card.tasks.some((task) => /depend|lock|package/i.test(task.title));
    if (deps.length > 0 && !depTask) {
      findings.push({
        risk: `the diff touches ${deps.join(', ')} with no checklist task pairing a dependency change`,
        violates: 'law 3 (efficient — no unjustified new dependencies)',
      });
    }
    if (files.length > 60) {
      findings.push({
        risk: `the diff spans ${files.length} files — ceremony has outgrown the blast radius`,
        violates: 'law 1 (simple — ceremony scales with blast radius)',
      });
    }
  }
  return findings;
}

async function defaultBranchOf(projectPath: string): Promise<string> {
  const remote = await runGit(projectPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 5000);
  if (remote.code === 0) {
    const short = remote.stdout.trim().replace(/^origin\//, '');
    if (short.length > 0) return short;
  }
  return 'main';
}

export class ReviewBlockedError extends DeckError {
  constructor(cardId: string, readonly findings: Finding[]) {
    super(`archive blocked — ${findings.length} review finding(s) stand`, { cardId, count: findings.length });
  }
}

export function renderFindings(findings: Finding[]): string {
  return findings.map((finding) => `! ${finding.risk} — violates ${finding.violates}`).join('\n');
}

// --- archive tail ---------------------------------------------------------------

export interface TailOutcome {
  changelog: string;
  release: string | null;
  warnings: string[];
}

function changelogEntry(card: VerbItem, issueNumber: number, prUrl: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `- ${date} — ${card.verb}: ${card.title} (#${issueNumber}, ${prUrl})`;
}

// Best-effort by construction: changelog append + tagged release; failures
// warn and never undo the archive.
export async function archiveTail(
  store: DocumentStore,
  id: string,
  prUrl: string,
): Promise<TailOutcome> {
  const card = store.getVerbItem(id);
  const map = getIssueMap(store, id);
  const warnings: string[] = [];
  const entry = changelogEntry(card, map?.issueNumber ?? 0, prUrl);
  const changelogPath = join(store.projectPath, 'CHANGELOG.md');
  const prior = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
  const next = prior.length === 0 ? `# Changelog\n\n${entry}\n` : `${prior.trimEnd()}\n${entry}\n`;
  await Bun.write(changelogPath, next);

  let release: string | null = null;
  const tag = await runGit(store.projectPath, ['tag', '--points-at', 'HEAD'], 5000);
  if (tag.code === 0 && tag.stdout.trim() !== '') {
    const name = tag.stdout.trim().split('\n')[0]!;
    const version = newestSpecVersion(store, id);
    try {
      const result = await runGh(store.projectPath, [
        'release', 'create', name,
        '--title', name,
        '--notes', version?.markdown ?? `deck ${name}`,
      ]);
      if (result === null || result.code !== 0) {
        warnings.push(`release ${name} failed: ${result === null ? 'gh unavailable' : result.stderr.trim()}`);
      } else {
        release = result.stdout.trim().split('\n').pop() ?? name;
      }
    } catch (error) {
      warnings.push(`release ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { changelog: entry, release, warnings };
}

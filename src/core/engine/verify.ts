// Verify + review + archive tail (verify-review-archive, P1c): a deterministic
// converge driver whose ONLY writer is applyVerifyResult, a lean single-pass
// review gate that attacks the diff and blocks archive, and a best-effort
// archive tail. No AI anywhere in deck's loop — deck computes and enforces.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeckError } from '../board/errors.ts';
import { applyVerifyResult } from '../board/verify.ts';
import { moveLane } from '../board/lanes.ts';
import { newestSpecVersion } from '../board/specstore.ts';
import { getIssueMap } from '../board/specstore.ts';
import { getSpecType } from '../board/types-registry.ts';
import { listOverrides, loadRules, runChecks } from '../board/rules.ts';
import type { DocumentStore } from '../board/store.ts';
import { isTweak, isVerbItem, type VerbItem } from '../board/types.ts';
import { runGit } from '../git/digest.ts';
import { runGh } from '../git/gh.ts';
import { branchFor } from './slug.ts';
import { completeOperation, compensateOperation, reserveOperation } from './ownership.ts';
import { runMomentPost, runMomentPre } from './moments.ts';
import type { HookWarning } from './hooks.ts';

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

export function kebab(name: string): string {
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
// The documented contract ('deck verify <id> closes the loop') is reachable:
// verify on an ACTIVE card transitions it into verify first — the engine
// owns active→verify, archive is not the only door. Tweaks share this door
// (they verify explicitly); computed verification below stays verb-only.
export function ensureVerifyLane(store: DocumentStore, id: string): void {
  const card = store.getCard(id); // typed 404 for unknown ids
  if (!isVerbItem(card) && !isTweak(card)) {
    throw new DeckError(`card ${id} is not a build card — verification runs on verb items and tweaks`, {
      cardId: id,
    });
  }
  if (card.lane === 'active') moveLane(store, id, 'verify', 'engine');
}

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
// only mutation path for gaps (→ active + tasks appended). A CLEAN result
// HOLDS in verify: done is archive's merge door alone (deck-review-archive
// law; a clean→done jump skipped the PR and stranded the card).
// Computed verification is verb-item-only: a tweak has no spec to compute
// gaps from, so it must refuse BEFORE ensureVerifyLane could move anything
// (a move-then-throw would strand the tweak in verify).
// Shared payload for the verify/review moments (all fields the pinned
// envelope and declared hooks read).
export function momentPayload(
  store: DocumentStore,
  moment: 'verify' | 'review',
  card: VerbItem,
  result: 'clean' | 'gaps' | null,
): Parameters<typeof runMomentPost>[2] {
  return {
    moment,
    cardId: card.id,
    lane: card.lane,
    verb: card.verb,
    branch: branchFor(card, card.verb),
    issueNumber: getIssueMap(store, card.id)?.issueNumber ?? null,
    result,
    card,
    timestamp: new Date().toISOString(),
  };
}

export async function runVerification(store: DocumentStore, id: string): Promise<ConvergeOutcome> {
  const before = store.getCard(id); // typed 404 for unknown ids
  if (!isVerbItem(before)) {
    throw new DeckError(
      `card ${id} is not a verb item — computed verification needs a spec; tweaks verify explicitly (deck verify <id> --result clean|gaps)`,
      { cardId: id },
    );
  }
  // verify moment pre: blocks before the active→verify move or any result
  // application — the pre hook sees the card where it stands.
  await runMomentPre(store, 'verify', momentPayload(store, 'verify', before, null));
  ensureVerifyLane(store, id);
  const gaps = computeGaps(store, id);
  const result = gaps.length === 0 ? 'clean' as const : 'gaps' as const;
  if (result === 'gaps') applyVerifyResult(store, id, result, gaps.map((gap) => gap.taskTitle));
  const card = store.getVerbItem(id);
  // The verify post phase (and the pinned onVerifyResult convention event
  // inside it) fires on both outcomes (core, so both doors fire it).
  const hookWarnings = await runMomentPost(store, 'verify', momentPayload(store, 'verify', card, result));
  return { result, gaps, card, hookWarnings };
}

// The review gate lives in review.ts; the door surface stays reachable from here.
export { reviewGate, renderFindings, ReviewBlockedError, type Finding } from './review.ts';

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

// The new version when the archived change bumps it (package.json version
// or src/version.ts), else null. HEAD^1..HEAD is the archived change both
// before the merge (the branch tip's last commit) and after (--no-ff merge
// against the prior main).
export async function versionBumpedInDiff(projectPath: string, _card: VerbItem): Promise<string | null> {
  const diff = await runGit(
    projectPath,
    ['diff', 'HEAD^1', 'HEAD', '--', 'package.json', 'src/version.ts'],
    10_000,
  );
  if (diff.code !== 0 || !diff.stdout.includes('+')) return null;
  const added = diff.stdout
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  const pkg = /"version"\s*:\s*"(\d+\.\d+\.\d+)"/.exec(added);
  if (pkg !== null) return pkg[1]!;
  const src = /DECK_VERSION = '(\d+\.\d+\.\d+)'/.exec(added);
  return src !== null ? src[1]! : null;
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
  let name = (await runGit(store.projectPath, ['tag', '--points-at', 'HEAD'], 5000)).stdout
    .trim()
    .split('\n')[0];
  if (name === undefined || name.length === 0) {
    // Release slice: a version bump in the archived diff names the release
    // itself — tag HEAD v<version>, push the tag, release from it. All
    // best-effort, like everything in the tail.
    const bumped = await versionBumpedInDiff(store.projectPath, card);
    if (bumped !== null) {
      try {
        const created = await runGit(
          store.projectPath,
          ['tag', '-a', `v${bumped}`, '-m', `deck release ${bumped}`],
          5000,
        );
        if (created.code === 0) await runGit(store.projectPath, ['push', 'origin', `v${bumped}`], 30_000);
        name = `v${bumped}`;
      } catch (error) {
        warnings.push(`tag v${bumped} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (name !== undefined && name.length > 0) {
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

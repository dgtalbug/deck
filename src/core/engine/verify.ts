// Verify + review + archive tail (verify-review-archive, P1c): a deterministic
// converge driver whose ONLY writer is applyVerifyResult, a lean single-pass
// review gate that attacks the diff and blocks archive, and a best-effort
// archive tail. No AI anywhere in deck's loop — deck computes and enforces.
import { join } from 'node:path';
import { DeckError } from '../board/errors.ts';
import { applyVerifyResult } from '../board/verify.ts';
import { moveLane } from '../board/lanes.ts';
import { newestSpecVersion } from '../board/specstore.ts';
import { getIssueMap } from '../board/specstore.ts';
import { getSpecType } from '../board/types-registry.ts';
import { listOverrides, loadRules, runChecks, getPolicy } from '../board/rules.ts';
import { scopeCriteria } from '../board/scope.ts';
import { evaluateEligibility } from './evidence.ts';
import type { DocumentStore } from '../board/store.ts';
import { isTweak, isVerbItem, type VerbItem } from '../board/types.ts';
import { runGit } from '../git/digest.ts';
import { branchFor } from './slug.ts';
import { runMomentPost, runMomentPre } from './moments.ts';
import type { HookWarning } from './hooks.ts';

// --- deterministic gap computation -------------------------------------------

export interface Gap {
  requirement?: string | undefined;
  taskTitle: string;
  evidence: string;
  // Additive E05 identity: the stable criterion and its current evidence
  // status, when the gap is an acceptance-evidence gap.
  criterionId?: string | undefined;
  evidenceStatus?: string | undefined;
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

// Pure data out — no mutations, no network. (a) unchecked tasks enumerate as
// gaps; (b) accepted criteria whose CURRENT evidence is unsatisfied are gaps
// (engine/evidence): a matching filename or a checked task is never proof.
// Requirements map to E03 criterion identity by title; unclassified legacy
// criteria surface as an identity gap instead of silently passing.
// Criterion titles are stored verbatim from the accepted delta ("Requirement:
// X"); parsed spec headers drop the prefix — both spellings are one identity.
function normalizeCriterionTitle(title: string): string {
  return title.replace(/^Requirement:\s*/i, '').trim();
}

export async function computeGaps(store: DocumentStore, id: string): Promise<Gap[]> {
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
  if (version === undefined) return gaps;
  const requirements = parseRequirementNames(version.markdown);
  if (requirements.length === 0) return gaps;
  const policy = getPolicy(store, id);
  if (policy === undefined) {
    // Unknown legacy scope stays unclassified until explicitly migrated —
    // never auto-accepted, never silently dropped.
    gaps.push({
      taskTitle: 'enroll a delivery/evidence policy for the accepted criteria',
      evidence: 'policy-unenrolled',
    });
    return gaps;
  }
  const active = scopeCriteria(store.db, id).filter((criterion) => criterion.state === 'active');
  const evaluation = await evaluateEligibility(store, id);
  for (const requirement of requirements) {
    const criterion = active.find((item) => normalizeCriterionTitle(item.title) === requirement);
    if (criterion === undefined) {
      gaps.push({
        requirement,
        taskTitle: `classify the criterion identity for "${requirement}" (reviewed edit)`,
        evidence: 'unclassified',
      });
      continue;
    }
    const status = evaluation.criteria.find((item) => item.criterionId === criterion.id);
    if (status === undefined || status.status !== 'satisfied') {
      gaps.push({
        requirement,
        criterionId: criterion.id,
        evidenceStatus: status?.status ?? 'missing',
        taskTitle: `provide evidence for "${requirement}" (${criterion.id})`,
        evidence: status?.status ?? 'missing',
      });
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
  const gaps = await computeGaps(store, id);
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

// The new version when the delivered change bumps it (package.json version
// or src/version.ts), else null. The diff binds to the RECORDED DELIVERY
// revision (E05) — deliveredSha's parent..deliveredSha is the delivered
// change, never incidental current HEAD. Cleanup (delivery-cleanup.ts) uses
// this to reconcile the release tag identity.
export async function versionBumpedInDiff(
  projectPath: string,
  _card: VerbItem,
  deliveredSha?: string | undefined,
): Promise<string | null> {
  const sha = deliveredSha !== undefined && deliveredSha !== '' ? deliveredSha : 'HEAD';
  const diff = await runGit(
    projectPath,
    ['diff', `${sha}^1`, sha, '--', 'package.json', 'src/version.ts'],
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

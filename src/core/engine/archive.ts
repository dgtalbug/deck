// The archive door (feat-verb-gate archive side) — extracted from verbs.ts
// (make-build-execution-trustworthy): spec-generated PR merged --no-ff under
// an archive checkout reservation (engine/ownership), the review gate as a
// fail-closed precondition (engine/verify), done through the verify core,
// mapped issue closed, branch deleted.
import { rmSync } from 'node:fs';
import { DeckError } from '../board/errors.ts';
import { mostAdvancedActive, moveLane } from '../board/lanes.ts';
import { applyVerifyResult } from '../board/verify.ts';
import { getIssueMap, listQueue, newestSpecVersion } from '../board/specstore.ts';
import { GhUnavailableError, GitOpError } from '../git/errors.ts';
import { runGit } from '../git/digest.ts';
import {
  createBranch,
  createPullRequest,
  deleteBranch,
  mergeBranch,
  pushRemote,
  switchBranch,
} from '../git/ops.ts';
import type { DocumentStore } from '../board/store.ts';
import type { VerbItem } from '../board/types.ts';
import { scaffoldSession, sessionPath } from '../board/memory.ts';
import { reviewGate, ReviewBlockedError } from './review.ts';
import { archiveTail } from './verify.ts';
import { closeIssue } from '../git/issues.ts';
import { runMomentPost, runMomentPre } from './moments.ts';
import type { HookWarning } from './hooks.ts';
import {
  compensateOperation,
  completeOperation,
  reserveOperation,
  type Operation,
} from './ownership.ts';
import { branchFor } from './slug.ts';

export async function assertCleanTree(projectPath: string): Promise<void> {
  const status = await runGit(projectPath, ['status', '--porcelain']);
  if (status.code !== 0) {
    throw new DeckError(`cannot inspect the working tree in ${projectPath}`, {
      output: `${status.stdout}${status.stderr}`.trim(),
    });
  }
  if (status.stdout.trim() !== '') {
    throw new DeckError(
      `working tree is not clean — commit or stash before starting a verb build`,
      { dirty: status.stdout.trim() },
    );
  }
}

export async function defaultBranch(projectPath: string): Promise<string> {
  const remote = await runGit(projectPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 5000);
  if (remote.code === 0) {
    const short = remote.stdout.trim().replace(/^origin\//, '');
    if (short.length > 0) return short;
  }
  return 'main';
}

export interface ArchiveOutcome {
  card: VerbItem;
  prUrl: string;
  issueNumber: number;
  tail: { changelog: string; release: string | null; warnings: string[] };
  /** best-effort follow-ups that failed after the card reached done */
  warnings: string[];
  hookWarnings: HookWarning[];
}

// Minimal archive: the PR body IS the spec (zero hand-written markdown),
// the merge is --no-ff, done arrives through applyVerifyResult, and the
// mapped issue closes. gh offline refuses BEFORE any mutation — a merge is
// the one place the network is load-bearing.
export async function archiveVerb(store: DocumentStore, id: string): Promise<ArchiveOutcome> {
  const card = store.getVerbItem(id);
  if (card.lane !== 'active' && card.lane !== 'verify') {
    throw new DeckError(
      `card ${id} is in ${card.lane} — archive runs on an active or verify verb item`,
      { cardId: id, lane: card.lane },
    );
  }
  const map = getIssueMap(store, id);
  if (map === undefined) {
    // The start ran; the publish may simply still be queued (gh offline).
    if (listQueue(store).some((entry: { cardId: string }) => entry.cardId === id)) {
      throw new DeckError(
        `card ${id}'s issue publish is still queued (gh was offline at start) — run deck sync to flush it, then archive`,
        { cardId: id },
      );
    }
    throw new DeckError(`card ${id} has no published issue — run its verb start first`, { cardId: id });
  }
  const version = newestSpecVersion(store, id);
  if (version === undefined) {
    throw new DeckError(`card ${id} has no spec version to build the PR body from`, { cardId: id });
  }

  // Refuse loudly before mutating when the publication cannot close.
  const probe = await runGit(store.projectPath, ['rev-parse', '--git-dir'], 3000);
  if (probe.code !== 0) {
    throw new DeckError(`cannot archive outside a git repository`, { cardId: id });
  }

  // engine/ownership: the archive takes the checkout reservation before the
  // review gate runs — a foreign owner (or an unreconciled crashed operation)
  // refuses before any delivery effect is possible.
  const operation = reserveOperation(store, id, 'archive');
  try {
    return await archiveDeliver(store, id, card, map, version, operation);
  } catch (error) {
    try {
      compensateOperation(store, operation.id);
    } catch {
      // The operation already reached a terminal state (delivered or
      // reconciled elsewhere) — the original error carries the story.
    }
    throw error;
  }
}

// The guarded delivery sequence, under the archive reservation. Wrong
// snapshot, unavailable base or failed diff never reach the push/PR/merge
// sequence: the review gate fails closed on all three (engine/verify).
async function archiveDeliver(
  store: DocumentStore,
  id: string,
  card: VerbItem,
  map: { issueNumber: number },
  version: { markdown: string },
  operation: Operation,
): Promise<ArchiveOutcome> {
  const branch = branchFor(card, card.verb);
  const base = await defaultBranch(store.projectPath);

  // The review gate blocks archive while any finding stands (P1c D5) —
  // before any mutation, nothing to unwind.
  const findings = await reviewGate(store, id);
  if (findings.length > 0) throw new ReviewBlockedError(id, findings);

  // archive moment pre: blocks before the push/PR/merge sequence begins.
  await runMomentPre(store, 'archive', {
    moment: 'archive',
    cardId: id,
    lane: card.lane,
    verb: card.verb,
    branch,
    issueNumber: map.issueNumber,
    result: null,
    card,
    timestamp: new Date().toISOString(),
  });

  // Guarded sequence on clean trees only. gh cannot open a PR for a branch
  // the remote has never seen — push the verb branch first, and push the
  // merge after, so the loop closes on the remote too.
  await assertCleanTree(store.projectPath);
  const remote = await runGit(store.projectPath, ['remote']);
  if (remote.stdout.trim() === '') {
    throw new DeckError('archive requires a git remote — push the repository to origin first', {
      cardId: id,
    });
  }
  const current = await runGit(store.projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current.stdout.trim() !== branch) {
    await switchBranch(store.projectPath, branch);
  }
  await pushRemote(store.projectPath);
  const pr = await createPullRequest(store.projectPath, {
    title: `merge: ${branch} — ${card.title}`,
    base,
    body: version.markdown,
  });
  await switchBranch(store.projectPath, base);
  await mergeBranch(store.projectPath, branch, {
    noFf: true,
    message: `merge: ${branch} — ${card.title}`,
  });
  await pushRemote(store.projectPath);

  // Card → verify → done through the existing cores (never a raw lane write).
  if (card.lane === 'active') moveLane(store, id, 'verify', 'engine');
  applyVerifyResult(store, id, 'clean');
  // Delivery is complete: the archive reservation ends here (owner-
  // conditional), before the best-effort follow-ups.
  completeOperation(store, operation.id);

  // Post-done follow-ups are best-effort by construction: the merge is
  // pushed and the card is done — a failing issue close or branch delete
  // must NOT throw into an unretryable state (archive refuses done cards).
  // Failures become warnings; deck sync reports the leftover drift.
  const warnings: string[] = [];
  try {
    await closeIssue(store.projectPath, map.issueNumber);
  } catch (error) {
    warnings.push(
      `issue #${map.issueNumber} not closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    await deleteBranch(store.projectPath, branch);
  } catch (error) {
    warnings.push(`branch ${branch} not deleted: ${error instanceof Error ? error.message : String(error)}`);
  }
  const tail = await archiveTail(store, id, pr.url);
  warnings.push(...tail.warnings);
  const done = store.getVerbItem(id);
  // The archive post phase (and the pinned onArchive convention event inside
  // it) fires after the loop has fully closed.
  const hookWarnings = await runMomentPost(store, 'archive', {
    moment: 'archive',
    cardId: id,
    lane: done.lane,
    verb: done.verb,
    branch,
    issueNumber: map.issueNumber,
    result: null,
    card: done,
    timestamp: new Date().toISOString(),
  });
  return { card: done, prUrl: pr.url, issueNumber: map.issueNumber, tail, warnings, hookWarnings };
}


// The archive door (E05 DECK-ARCH-014): preparation and policy-checked
// finalization replace immediate archive merging. Preparation reviews, pushes
// ONLY the owned feature branch, creates or reuses the spec-generated PR
// through the provider-intent ledger, records the delivery attempt and leaves
// the card in verify — an open PR is never completed work. Finalization
// (delivery.ts) requires an observed merge under the persisted policy. Both
// doors enforce current evidence, fail-closed review and E01 checkout
// ownership before Git effects. The legacy --no-ff merge of the default
// branch is gone by user-confirmed policy migration (2026-09-14).
import { DeckError } from '../board/errors.ts';
import { moveLane } from '../board/lanes.ts';
import { getIssueMap, listQueue, newestSpecVersion } from '../board/specstore.ts';
import { GhUnavailableError, GitOpError } from '../git/errors.ts';
import { runGit } from '../git/digest.ts';
import {
  createPullRequest,
  pushRemote,
  searchPullRequestsByMarker,
  switchBranch,
} from '../git/ops.ts';
import type { DocumentStore } from '../board/store.ts';
import type { VerbItem } from '../board/types.ts';
import { reviewGate, ReviewBlockedError } from './review.ts';
import { closeIssue } from '../git/issues.ts';
import { runMomentPost, runMomentPre } from './moments.ts';
import type { HookWarning } from './hooks.ts';
import {
  canonicalProjectId,
  claimIntent,
  completeIntent,
  failIntent,
  listCardOperations,
  markerFor,
  markUncertain,
  recordIntent,
  reconcileOperation,
} from '../board/provider-operations.ts';
import type { ProviderOperationRow } from '../board/schema.ts';
import {
  compensateOperation,
  completeOperation,
  ownerToken,
  reserveOperation,
  type Operation,
} from './ownership.ts';
import { branchFor } from './slug.ts';
import { evaluateEligibility } from './evidence.ts';
import { getPolicy } from '../board/rules.ts';
import { recordDeliveryAttempt } from './delivery.ts';
import { captureExecutionInputs } from './evidence-inputs.ts';

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
  prUrl: string | null;
  issueNumber: number;
  /** delivery is PENDING after preparation — an open PR is not done */
  delivery: { id: string; state: string; prNumber: number | null; reused: boolean };
  /** kept for caller compatibility; tail work moved to delivery cleanup */
  tail: { changelog: string; release: string | null; warnings: string[] };
  warnings: string[];
  hookWarnings: HookWarning[];
}

// Minimal archive (preparation side): review gate → evidence gate → push the
// owned branch → PR create/reuse via the intent ledger → delivery recorded
// pending. The card stays in verify until explicit finalization observes a
// valid merge (deck deliver).
export async function archiveVerb(store: DocumentStore, id: string): Promise<ArchiveOutcome> {
  const card = store.getVerbItem(id);
  if (card.lane !== 'active' && card.lane !== 'verify') {
    throw new DeckError(
      `card ${id} is in ${card.lane} — archive (preparation) runs on an active or verify verb item`,
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
  const policy = getPolicy(store, id);
  if (policy === undefined) {
    // Explicit migration choice (DECK-ARCH-014): unfinished cards are never
    // silently adopted into the new delivery law.
    throw new DeckError(
      `card ${id} has no enrolled delivery/evidence policy — enroll one (deck policy <id> --mode team|solo ...) before delivery`,
      { cardId: id },
    );
  }

  // engine/ownership: preparation takes the checkout reservation before the
  // review gate runs — a foreign owner (or an unreconciled crashed operation)
  // refuses before any delivery effect is possible.
  const operation = reserveOperation(store, id, 'archive');
  try {
    return await prepareDelivery(store, id, card, map, version, policy.mode, operation);
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

async function prepareDelivery(
  store: DocumentStore,
  id: string,
  card: VerbItem,
  map: { issueNumber: number },
  version: { markdown: string },
  mode: 'team' | 'solo',
  operation: Operation,
): Promise<ArchiveOutcome> {
  const branch = branchFor(card, card.verb);
  const base = await defaultBranch(store.projectPath);

  // The review gate blocks preparation while any finding stands — before any
  // mutation, nothing to unwind. It also captures required-check evidence.
  const findings = await reviewGate(store, id);
  if (findings.length > 0) throw new ReviewBlockedError(id, findings);

  // Evidence gate: every accepted criterion needs CURRENT machine/manual
  // evidence (engine/evidence). Review just captured; stale records refuse.
  const evidence = await evaluateEligibility(store, id);
  if (!evidence.eligible) {
    throw new DeckError(
      `card ${id}'s acceptance evidence is not current — ${evidence.reasons.join('; ')}`,
      { cardId: id, reasons: evidence.reasons },
    );
  }

  // archive moment pre: blocks before the push/PR sequence begins.
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

  // Preparation requires a clean committed tree: review may have bound
  // dirty-worktree evidence, but the PR carries committed bytes — evidence
  // for the committed head is what the evaluation above just re-checked.
  await assertCleanTree(store.projectPath);
  const remote = await runGit(store.projectPath, ['remote']);
  if (mode === 'team' && remote.stdout.trim() === '') {
    throw new DeckError('team delivery requires a git remote — push the repository to origin first (or enroll solo mode)', {
      cardId: id,
    });
  }

  const inputs = await captureExecutionInputs(store.projectPath, { base });
  let prNumber: number | null = null;
  let prUrl: string | null = null;
  let reused = false;

  if (mode === 'team') {
    const current = await runGit(store.projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (current.stdout.trim() !== branch) {
      await switchBranch(store.projectPath, branch);
    }
    await pushRemote(store.projectPath);
    const projectId = canonicalProjectId(store);
    const marker = markerFor(projectId, id);
    const resolved = await resolvePullRequest(store, id, marker, version.markdown, branch, base);
    prNumber = resolved.number;
    prUrl = resolved.url;
    reused = resolved.reused;
  }

  // Delivery attempt recorded pending: the PR (or solo local intent) is NOT
  // completion. Solo finalization later integrates locally under guards.
  const delivery = recordDeliveryAttempt(store, {
    cardId: id,
    mode,
    policyVersion: (await import('../board/rules.ts')).getPolicy(store, id)!.version,
    scopeRevision: (await import('../board/scope.ts')).currentScopeRevision(store.db, id),
    inputFingerprint: inputs.fingerprint,
    headSha: inputs.headSha,
    baseBranch: base,
    prNumber,
    prUrl,
  });

  // Card → verify (never done): completion is finalization's alone.
  if (card.lane === 'active') moveLane(store, id, 'verify', 'engine');
  completeOperation(store, operation.id);

  const done = store.getVerbItem(id);
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
  return {
    card: done,
    prUrl,
    issueNumber: map.issueNumber,
    delivery: { id: delivery.id, state: delivery.state, prNumber, reused },
    tail: { changelog: '', release: null, warnings: [] },
    warnings: [
      `delivery pending — card ${id} stays in verify until deck deliver <id> observes a valid ${mode === 'team' ? 'merge' : 'local integration'}`,
    ],
    hookWarnings,
  };
}

// PR create-or-reuse over the intent ledger (DECK-ARCH-013): an unresolved
// pr-create intent reconciles by marker BEFORE another create — a crash after
// a successful create reuses the original PR instead of duplicating it.
async function resolvePullRequest(
  store: DocumentStore,
  id: string,
  marker: string,
  body: string,
  branch: string,
  base: string,
): Promise<{ number: number; url: string; reused: boolean }> {
  const card = store.getVerbItem(id);
  // Reuse an existing open PR carrying the marker (or reconcile an uncertain
  // create) — marker search, never title guessing.
  const open = await searchPullRequestsByMarker(store.projectPath, marker, { state: 'open' });
  const pendingIntent = listCardOperations(store, id)
    .filter((op) => op.kind === 'pr-create' && ['claimed', 'uncertain', 'legacy-unobserved'].includes(op.state))
    .at(-1);
  if (open.length === 1) {
    if (pendingIntent !== undefined) {
      reconcileOperation(store, pendingIntent.id, [{ remoteId: String(open[0]!.number), remoteUrl: open[0]!.url }]);
    }
    const pr = open[0]!;
    return { number: pr.number, url: pr.url, reused: true };
  }
  if (open.length > 1) {
    throw new DeckError(
      `${open.length} open PRs carry card ${id}'s marker — resolve the duplicate on the provider, then prepare again`,
      { cardId: id, matches: open.map((pr) => pr.number) },
    );
  }
  if (pendingIntent !== undefined) {
    // Zero visible matches for a dispatched create is NOT proof of absence.
    const row = reconcileOperation(store, pendingIntent.id, []);
    throw new DeckError(
      `PR creation for card ${id} is ${row.state} — ${row.nextAction ?? 'reconcile before retrying'}`,
      { cardId: id, operationId: row.id },
    );
  }

  const intent = recordIntent(store, {
    cardId: id,
    kind: 'pr-create',
    repo: '',
    projectId: canonicalProjectId(store),
    marker,
    payload: { title: `merge: ${branch} — ${card.title}`, base, branch },
    expectedHead: (await runGit(store.projectPath, ['rev-parse', 'HEAD'], 5000)).stdout.trim(),
    expectedBase: base,
  });
  let claimed: ProviderOperationRow;
  try {
    claimed = claimIntent(store, intent.id, ownerToken);
  } catch (error) {
    if (error instanceof DeckError && /not claimable/.test(error.message)) {
      throw new DeckError(`another worker is creating card ${id}'s PR — retry preparation`, { cardId: id });
    }
    throw error;
  }
  try {
    const pr = await createPullRequest(store.projectPath, {
      title: `merge: ${branch} — ${card.title}`,
      base,
      body,
    });
    const number = Number(pr.url.match(/\/pull\/(\d+)/)?.[1]);
    completeIntent(store, intent.id, ownerToken, String(number), pr.url);
    return { number, url: pr.url, reused: false };
  } catch (error) {
    if (error instanceof GhUnavailableError) {
      await markUncertain(store, intent.id, ownerToken, 'gh unavailable mid-create');
      throw error;
    }
    if (error instanceof GitOpError) {
      failIntent(store, intent.id, ownerToken, `${error.message}: ${error.details['output'] ?? ''}`.trim(), 'inspect the provider error, fix the cause, then prepare again');
    }
    throw error;
  }
}

// Kept for cleanup reuse (delivery-cleanup closes the mapped issue through
// the ledger); the old immediate archive merge path is gone.
export { closeIssue };

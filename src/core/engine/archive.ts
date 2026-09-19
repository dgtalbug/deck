import { executionPath } from '../board/context.ts';
import { DeckError } from '../board/errors.ts';
import { moveLane } from '../board/lanes.ts';
import { getIssueMap, listQueue, newestSpecVersion } from '../board/specstore.ts';
import { GhUnavailableError, GitOpError } from '../git/errors.ts';
import { runGit } from '../git/digest.ts';
import {
  createPullRequest,
  pushRemote,
  remoteBranchHead,
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
  guardEffect,
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
  ensureLeaseFresh,
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
  delivery: { id: string; state: string; prNumber: number | null; reused: boolean };
  tail: { changelog: string; release: string | null; warnings: string[] };
  warnings: string[];
  hookWarnings: HookWarning[];
}

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
    throw new DeckError(
      `card ${id} has no enrolled delivery/evidence policy — enroll one (deck policy <id> --mode team|solo ...) before delivery`,
      { cardId: id },
    );
  }

  const operation = reserveOperation(store, id, 'archive');
  ensureLeaseFresh(store, operation);
  try {
    return await prepareDelivery(store, id, card, map, version, policy.mode, operation);
  } catch (error) {
    try {
      compensateOperation(store, operation.id);
    } catch {
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
  const checkout = executionPath(store, id);
  const base = await defaultBranch(checkout);

  const findings = await reviewGate(store, id);
  if (findings.length > 0) throw new ReviewBlockedError(id, findings);

  const evidence = await evaluateEligibility(store, id);
  if (!evidence.eligible) {
    throw new DeckError(
      `card ${id}'s acceptance evidence is not current — ${evidence.reasons.join('; ')}`,
      { cardId: id, reasons: evidence.reasons },
    );
  }

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

  await assertCleanTree(checkout);
  const remote = await runGit(checkout, ['remote']);
  if (mode === 'team' && remote.stdout.trim() === '') {
    throw new DeckError('team delivery requires a git remote — push the repository to origin first (or enroll solo mode)', {
      cardId: id,
    });
  }

  const inputs = await captureExecutionInputs(checkout, { base });
  let prNumber: number | null = null;
  let prUrl: string | null = null;
  let reused = false;

  if (mode === 'team') {
    const current = await runGit(checkout, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (current.stdout.trim() !== branch) {
      await switchBranch(checkout, branch);
    }
    // Durable intent before the push effect: observe the remote ref first so
    // a retry after response loss reuses the pushed head instead of re-pushing.
    const pushBranch = branch;
    const pushHead = (await runGit(checkout, ['rev-parse', 'HEAD'])).stdout.trim();
    await guardEffect(
      store,
      {
        cardId: id,
        kind: 'branch-push',
        repo: '',
        projectId: canonicalProjectId(store),
        marker: `deck:push:${canonicalProjectId(store)}:${pushBranch}`,
        payload: { branch: pushBranch, head: pushHead },
        operationId: operation.id,
        step: 'branch-push',
        expectedRef: pushHead,
      },
      ownerToken,
      async () => {
        const remote = await remoteBranchHead(checkout, pushBranch);
        return remote === null ? [] : [{ remoteId: remote, remoteUrl: `refs/heads/${pushBranch}` }];
      },
      async () => {
        await pushRemote(checkout);
        return pushHead;
      },
      (head) => ({ remoteId: head, remoteUrl: `refs/heads/${pushBranch}` }),
    );
    const projectId = canonicalProjectId(store);
    const marker = markerFor(projectId, id);
    const resolved = await resolvePullRequest(store, id, marker, version.markdown, branch, base);
    prNumber = resolved.number;
    prUrl = resolved.url;
    reused = resolved.reused;
  }

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

async function resolvePullRequest(
  store: DocumentStore,
  id: string,
  marker: string,
  body: string,
  branch: string,
  base: string,
): Promise<{ number: number; url: string; reused: boolean }> {
  const card = store.getVerbItem(id);
  const open = await searchPullRequestsByMarker(executionPath(store, id), marker, { state: 'open' });
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
    expectedHead: (await runGit(executionPath(store, id), ['rev-parse', 'HEAD'], 5000)).stdout.trim(),
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
    const pr = await createPullRequest(executionPath(store, id), {
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

export { closeIssue };

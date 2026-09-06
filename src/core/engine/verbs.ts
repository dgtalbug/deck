// Engine verbs (feat-verb-gate, P1b — THE GATE): `deck feat`/`deck fix` on
// one shared engine (the verb is data, not a branch in logic). Start =
// engine transition groomed→active, publish-at-start (queued offline,
// never blocking), guarded branch create with full compensation on refusal.
// Archive = spec-generated PR merged --no-ff, card → done through the
// existing verify core, mapped issue closed, branch deleted.
import { DeckError } from '../board/errors.ts';
import { assertUnderWip, moveLane } from '../board/lanes.ts';
import { applyVerifyResult } from '../board/verify.ts';
import { newestSpecVersion, getIssueMap } from '../board/specstore.ts';
import { publishSpec } from '../board/publish.ts';
import { closeIssue } from '../git/issues.ts';
import { GhUnavailableError } from '../git/errors.ts';
import { runGit } from '../git/digest.ts';
import {
  createBranch,
  createPullRequest,
  deleteBranch,
  mergeBranch,
  switchBranch,
} from '../git/ops.ts';
import type { DocumentStore } from '../board/store.ts';
import type { Verb, VerbItem } from '../board/types.ts';

function titleSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 4)
    .join('-')
    .slice(0, 32);
}

// Deterministic per card: the branch for a started verb is always
// re-derivable from the card itself (engine lanes refuse title edits, so
// the slug cannot drift mid-build).
export function branchFor(card: Pick<VerbItem, 'id' | 'title'>, verb: Verb): string {
  const slug = titleSlug(card.title);
  return slug.length > 0 ? `${verb}/${card.id}-${slug}` : `${verb}/${card.id}`;
}

async function assertCleanTree(projectPath: string): Promise<void> {
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

async function defaultBranch(projectPath: string): Promise<string> {
  const remote = await runGit(projectPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 5000);
  if (remote.code === 0) {
    const short = remote.stdout.trim().replace(/^origin\//, '');
    if (short.length > 0) return short;
  }
  return 'main';
}

// --- start ------------------------------------------------------------------

export interface StartOutcome {
  card: VerbItem;
  branch: string;
  issueNumber: number | null;
  queued: boolean;
}

// D2 order: transition → publish → branch. A refusal after the transition
// compensates back to groomed — a refusal must leave zero side effects.
export async function startVerb(
  store: DocumentStore,
  id: string,
  verb: Verb,
): Promise<StartOutcome> {
  const card = store.getVerbItem(id); // 404 contract
  if (card.lane !== 'groomed') {
    throw new DeckError(`card ${id} is in ${card.lane} — verbs start from groomed`, {
      cardId: id,
      lane: card.lane,
    });
  }
  if (card.verb !== verb) {
    throw new DeckError(
      `card ${id} was groomed as '${card.verb}' — '${verb}' refuses to claim another verb's work`,
      { cardId: id, cardVerb: card.verb, requested: verb },
    );
  }
  assertUnderWip(store);

  moveLane(store, id, 'active', 'engine');
  let publish;
  try {
    publish = await publishSpec(store, id); // queues on offline, never blocks
  } catch (error) {
    moveLane(store, id, 'groomed', 'engine'); // compensate
    throw error;
  }
  const branch = branchFor(card, verb);
  try {
    await assertCleanTree(store.projectPath);
    await createBranch(store.projectPath, { name: branch, checkout: true });
  } catch (error) {
    moveLane(store, id, 'groomed', 'engine'); // compensate — no side effects
    throw error;
  }
  return {
    card: store.getVerbItem(id),
    branch,
    issueNumber: publish.issueNumber,
    queued: publish.queued,
  };
}

// --- archive ------------------------------------------------------------------

export interface ArchiveOutcome {
  card: VerbItem;
  prUrl: string;
  issueNumber: number;
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

  const branch = branchFor(card, card.verb);
  const base = await defaultBranch(store.projectPath);

  // Guarded sequence on clean trees only.
  await assertCleanTree(store.projectPath);
  const current = await runGit(store.projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current.stdout.trim() !== branch) {
    await switchBranch(store.projectPath, branch);
  }
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

  // Card → verify → done through the existing cores (never a raw lane write).
  if (card.lane === 'active') moveLane(store, id, 'verify', 'engine');
  applyVerifyResult(store, id, 'clean');

  await closeIssue(store.projectPath, map.issueNumber);
  await deleteBranch(store.projectPath, branch);
  return { card: store.getVerbItem(id), prUrl: pr.url, issueNumber: map.issueNumber };
}

// Kept for the offline-at-archive refusal contract (design D5): callers
// probe reachability with this before archiveVerb when they want the loud
// pre-flight rather than the mid-sequence failure.
export async function assertGhReachable(projectPath: string): Promise<void> {
  const { runGh } = await import('../git/gh.ts');
  const result = await runGh(projectPath, ['auth', 'status']);
  if (result === null || result.code !== 0) {
    throw new GhUnavailableError(result === null ? '' : `${result.stdout}${result.stderr}`.trim());
  }
}

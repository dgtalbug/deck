// Engine verbs (feat-verb-gate, P1b — THE GATE): `deck feat`/`deck fix` on
// one shared engine (the verb is data, not a branch in logic). Start =
// engine transition groomed→active, publish-at-start (queued offline,
// never blocking), guarded branch create with full compensation on refusal.
// The archive side lives in archive.ts; the review gate in review.ts.
import { DeckError, DependencyBlockedError } from '../board/errors.ts';
import { assertUnderWip, mostAdvancedActive, moveLane } from '../board/lanes.ts';
import { getIssueMap, deleteIssueMap, dequeuePublish } from '../board/specstore.ts';
import { publishSpec } from '../board/publish.ts';
import { GhUnavailableError, GitOpError } from '../git/errors.ts';
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createBranch } from '../git/ops.ts';
import { runTx, type DocumentStore, type Tx } from '../board/store.ts';
import { cards, storyDeps } from '../board/schema.ts';
import {
  activateOperation,
  canonicalCheckout,
  completeOperation,
  compensateOperation,
  ownerToken,
  reserveOperationInTx,
  type Operation,
} from './ownership.ts';
import { getSpecType, sectionGate } from '../board/types-registry.ts';
import type { VerbName, VerbItem } from '../board/types.ts';

// The branch for a started verb is always re-derivable from the card
// itself (engine lanes refuse title edits, so the slug cannot drift).
import { branchFor } from './slug.ts';
import { scaffoldSession, sessionPath } from '../board/memory.ts';
import { assertCleanTree } from './archive.ts';
import { runMomentPost, runMomentPre, type MomentPayload } from './moments.ts';
import type { HookWarning } from './hooks.ts';
export { branchFor };
// The archive door shares this module's door surface (tests + CLI import
// archiveVerb from here); the implementation is archive.ts.
export { archiveVerb } from './archive.ts';

// --- start ------------------------------------------------------------------

export interface StartOutcome {
  card: VerbItem;
  branch: string;
  issueNumber: number | null;
  queued: boolean;
  hookWarnings: HookWarning[];
  // E03: persisted readiness facts that could not be re-derived at start.
  readinessUnknown?: string[] | undefined;
}

// D2 order: transition → publish → branch. A refusal after the transition
// compensates back to groomed — a refusal must leave zero side effects.
// engine/ownership: the start is RESERVED atomically (state + WIP counting
// reservations + checkout guard in one transaction) before any awaited hook;
// completion, release and compensation are owner-conditional, so concurrent
// starts yield exactly one owner and a loser can never reset the winner.
export async function startVerb(
  store: DocumentStore,
  id: string,
  verb: VerbName,
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
  // Spec-type gate, re-checked at the door: a registry tightened between
  // groom and start must not let a now-invalid card through.
  const type = getSpecType(store, verb);
  const missingSections = sectionGate(type, card.research);
  if (missingSections.length > 0) {
    throw new DeckError(
      `card ${id} as '${verb}' is missing required section(s): ${missingSections.join(', ')} — ` +
        `the spec type was tightened after grooming; re-groom with the sections filled`,
      { cardId: id, verb, missing: missingSections },
    );
  }
  // E03 DECK-ARCH-008: persisted readiness facts the current rules cannot
  // re-derive (accepted deltas are not persisted) are labeled unknown —
  // never inferred as answered.
  const persistedSpecContent =
    (card.research.story ?? '').trim() !== '' ||
    card.research.codebaseFindings.length > 0 ||
    Object.values(card.research.sections ?? {}).some((content) => content.trim() !== '');
  const readinessUnknown: string[] = [];
  if (card.tasks.length > 3 && !persistedSpecContent) {
    readinessUnknown.push('story shape (accepted deltas are not persisted on legacy cards)');
  }
  assertUnderWip(store);

  // The reservation transaction: serialized lane re-read, checkout guard,
  // WIP (counting reservations) and the reservation INSERT — one
  // BEGIN IMMEDIATE transaction, before any awaited hook runs.
  const owner = ownerToken;
  const checkout = canonicalCheckout(store.projectPath);
  let operation: Operation | undefined;
  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, id)).get();
    if (row === undefined || row.lane !== 'groomed' || row.verb !== verb) {
      throw new DeckError(
        `card ${id} is not claimable as '${verb}' from lane '${row?.lane ?? 'missing'}' — state changed under the start`,
        { cardId: id, lane: row?.lane ?? 'missing', verb },
      );
    }
    // E03 DECK-ARCH-016: prerequisite readiness is re-checked INSIDE the E01
    // reservation boundary — a concurrent dependency edit or prerequisite
    // state change either commits before this read or the start refuses.
    // Satisfaction is lane `done` (engine policy), not a clean review.
    const blockers = unmetDependenciesInTx(tx, id);
    if (blockers.length > 0) throw new DependencyBlockedError(id, blockers);
    operation = reserveOperationInTx(tx, {
      cardId: id,
      kind: 'start',
      owner,
      checkout,
      wip: {
        limit: store.wipLimit,
        activeCount: store.activeCount(),
        topCardId: mostAdvancedActive(store)?.id ?? 'unknown',
      },
    });
  });

  // feat moment pre: a blocking hook refuses the start before the lane
  // moves, the branch is created, or the issue publishes. The reservation
  // compensates — no public active transition happened.
  try {
    await runMomentPre(store, 'feat', startPayload(store, card, 'groomed'));
  } catch (error) {
    compensateOperation(store, operation!.id);
    throw error;
  }

  moveLane(store, id, 'active', 'engine');
  activateOperation(store, operation!.id); // fail-closed if recovered elsewhere
  let publish;
  try {
    publish = await publishSpec(store, id); // queues on offline, never blocks
    if (!publish.queued) {
      // groom's draft-publish queue entry is satisfied by this direct
      // publish — a stale entry would wedge archive ("still queued").
      dequeuePublish(store, id);
    }
  } catch (error) {
    moveLane(store, id, 'groomed', 'engine'); // compensate
    compensateOperation(store, operation!.id);
    throw error;
  }
  const branch = branchFor(card, verb);
  try {
    await assertCleanTree(store.projectPath);
    await createBranch(store.projectPath, { name: branch, checkout: true });
    scaffoldSession(store.projectPath, id, verb, branch); // the memory slot
  } catch (error) {
    moveLane(store, id, 'groomed', 'engine'); // compensate — no side effects
    compensateOperation(store, operation!.id);
    rmSync(sessionPath(store.projectPath, id), { force: true }); // ... including the session file
    // ... and the publish side: the map row must not outlive the failed
    // start. The remote issue cannot be unwritten — report it as drift.
    let drift: string | undefined;
    if (publish !== undefined && !publish.queued && publish.issueNumber !== null) {
      deleteIssueMap(store, id);
      drift = `issue #${publish.issueNumber} was already published and stays open — deck sync reports it as drift`;
    }
    // Four-word law: uniqueness is git's — a same-titled second card lands
    // here. Raw git stderr would be opaque; name the branch and the fix.
    if (
      error instanceof GitOpError &&
      /already exists/i.test(`${error.message} ${String(error.details['output'] ?? '')}`)
    ) {
      throw new DeckError(
        `branch '${branch}' already exists — another card owns this name; ` +
          `retitle one of them and re-groom (verb + first four title words name the branch)` +
          (drift !== undefined ? ` (${drift})` : ''),
        { cardId: id, branch, drift },
      );
    }
    throw error;
  }
  // The start has fully committed: the reservation completes (owner-
  // conditional — a reconciled operation refuses here, fail-closed).
  completeOperation(store, operation!.id);
  const started = store.getVerbItem(id);
  // The feat post phase (and the pinned onVerbStart convention event inside
  // it) fires only after the start has fully committed.
  const hookWarnings = await runMomentPost(store, 'feat', startPayload(store, started, started.lane, {
    branch,
    issueNumber: publish.issueNumber,
  }));
  return {
    card: started,
    branch,
    issueNumber: publish.issueNumber,
    queued: publish.queued,
    hookWarnings,
    ...(readinessUnknown.length > 0 ? { readinessUnknown } : {}),
  };
}

// Shared payload builder for the feat moment: the pre phase carries the
// still-groomed card; the post phase the started one.
function startPayload(
  store: DocumentStore,
  card: VerbItem,
  lane: string,
  extra: { branch?: string; issueNumber?: number | null } = {},
): MomentPayload {
  return {
    moment: 'feat',
    cardId: card.id,
    lane,
    verb: card.verb,
    branch: extra.branch ?? branchFor(card, card.verb),
    issueNumber: extra.issueNumber ?? getIssueMap(store, card.id)?.issueNumber ?? null,
    result: null,
    card,
    timestamp: new Date().toISOString(),
  };
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

// Prerequisite satisfaction is lane `done` (engine policy): a clean verify
// holds in verify and does NOT satisfy dependents. Runs inside the caller's
// transaction so dependency edits and starts serialize at the same boundary.
function unmetDependenciesInTx(tx: Tx, cardId: string): Array<{ id: string; lane: string; title: string }> {
  const edges = tx.select().from(storyDeps).where(eq(storyDeps.cardId, cardId)).all();
  const blockers: Array<{ id: string; lane: string; title: string }> = [];
  for (const edge of edges) {
    const dep = tx.select().from(cards).where(eq(cards.id, edge.dependsOn)).get();
    if (dep === undefined || dep.lane !== 'done') {
      blockers.push({ id: edge.dependsOn, lane: dep?.lane ?? 'missing', title: dep?.title ?? 'missing' });
    }
  }
  return blockers;
}

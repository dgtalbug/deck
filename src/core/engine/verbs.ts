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

import { branchFor } from './slug.ts';
import { scaffoldSession, sessionPath } from '../board/memory.ts';
import { assertCleanTree } from './archive.ts';
import { runMomentPost, runMomentPre, type MomentPayload } from './moments.ts';
import type { HookWarning } from './hooks.ts';
export { branchFor };
export { archiveVerb } from './archive.ts';

export interface StartOutcome {
  card: VerbItem;
  branch: string;
  issueNumber: number | null;
  queued: boolean;
  hookWarnings: HookWarning[];
  readinessUnknown?: string[] | undefined;
}

export async function startVerb(
  store: DocumentStore,
  id: string,
  verb: VerbName,
): Promise<StartOutcome> {
  const card = store.getVerbItem(id); 
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
  const type = getSpecType(store, verb);
  const missingSections = sectionGate(type, card.research);
  if (missingSections.length > 0) {
    throw new DeckError(
      `card ${id} as '${verb}' is missing required section(s): ${missingSections.join(', ')} — ` +
        `the spec type was tightened after grooming; re-groom with the sections filled`,
      { cardId: id, verb, missing: missingSections },
    );
  }
  const persistedSpecContent =
    (card.research.story ?? '').trim() !== '' ||
    card.research.codebaseFindings.length > 0 ||
    Object.values(card.research.sections ?? {}).some((content) => content.trim() !== '');
  const readinessUnknown: string[] = [];
  if (card.tasks.length > 3 && !persistedSpecContent) {
    readinessUnknown.push('story shape (accepted deltas are not persisted on legacy cards)');
  }
  assertUnderWip(store);

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

  try {
    await runMomentPre(store, 'feat', startPayload(store, card, 'groomed'));
  } catch (error) {
    compensateOperation(store, operation!.id);
    throw error;
  }

  moveLane(store, id, 'active', 'engine');
  activateOperation(store, operation!.id); 
  let publish;
  try {
    publish = await publishSpec(store, id); 
    if (!publish.queued) {
      dequeuePublish(store, id);
    }
  } catch (error) {
    moveLane(store, id, 'groomed', 'engine'); 
    compensateOperation(store, operation!.id);
    throw error;
  }
  const branch = branchFor(card, verb);
  try {
    await assertCleanTree(store.projectPath);
    await createBranch(store.projectPath, { name: branch, checkout: true });
    scaffoldSession(store.projectPath, id, verb, branch); 
  } catch (error) {
    moveLane(store, id, 'groomed', 'engine'); 
    compensateOperation(store, operation!.id);
    rmSync(sessionPath(store.projectPath, id), { force: true }); 
    let drift: string | undefined;
    if (publish !== undefined && !publish.queued && publish.issueNumber !== null) {
      deleteIssueMap(store, id);
      drift = `issue #${publish.issueNumber} was already published and stays open — deck sync reports it as drift`;
    }
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
  completeOperation(store, operation!.id);
  const started = store.getVerbItem(id);
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

export async function assertGhReachable(projectPath: string): Promise<void> {
  const { runGh } = await import('../git/gh.ts');
  const result = await runGh(projectPath, ['auth', 'status']);
  if (result === null || result.code !== 0) {
    throw new GhUnavailableError(result === null ? '' : `${result.stdout}${result.stderr}`.trim());
  }
}

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
